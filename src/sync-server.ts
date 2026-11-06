import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import type { Config } from './config.ts';
import {
  ErrorCode,
  Op,
  PONG,
  PROTOCOL_VERSION,
  ProtocolError,
  VAULT_DELETED,
  decodeClientMessage,
  encodeAck,
  encodeChanges,
  encodeError,
  encodeSynced,
} from './protocol.ts';
import type { ClientMessage, StoredRecord } from './protocol.ts';
import type { Store } from './store.ts';
import { serveWebApp } from './web-app.ts';
import type { WebApp } from './web-app.ts';

/** Datensätze pro CHANGES-Nachricht beim Nachholen. */
const CATCH_UP_CHUNK = 500;
const HEARTBEAT_MS = 30_000;

/**
 * Die Vault-ID wird nur gehasht gespeichert: Wer die Datenbank liest, kann
 * damit nicht einmal Daten in einen Vault schreiben.
 */
export function vaultHash(vault: Buffer): Buffer {
  return createHash('sha256').update('antatime-vault').update(vault).digest();
}

/**
 * Alle Verbindungen zu einem Vault. Aufgaben eines Vaults laufen strikt
 * nacheinander. Dadurch gilt für jede Verbindung: Änderungen anderer Geräte
 * kommen in Sequenz-Reihenfolge an, und vor einem ACK sind alle kleineren
 * Sequenznummern bereits zugestellt.
 */
class Room {
  readonly id: Buffer;
  readonly key: string;
  readonly conns = new Set<Connection>();
  private queue: Promise<void> = Promise.resolve();
  pending = 0;

  constructor(id: Buffer) {
    this.id = id;
    this.key = id.toString('hex');
  }

  run(task: () => Promise<void>): Promise<void> {
    this.pending++;
    const next = this.queue.then(task).finally(() => this.pending--);
    this.queue = next.catch(() => {});
    return next;
  }
}

interface Connection {
  ws: WebSocket;
  room: Room | null;
  /** Nachholen abgeschlossen → erhält Änderungen anderer Geräte live. */
  live: boolean;
  alive: boolean;
  tokens: number;
  refilledAt: number;
}

export class SyncServer {
  private readonly rooms = new Map<string, Room>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly config: Config;
  private readonly store: Store;

  private readonly web: WebApp | null;

  constructor(config: Config, store: Store, web: WebApp | null = null) {
    this.config = config;
    this.store = store;
    this.web = web;
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.maxMessageBytes,
      // Die Nutzdaten sind verschlüsselt und lassen sich nicht komprimieren.
      perMessageDeflate: false,
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (pathOf(req) !== '/sync') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  /** Startet den Server; gibt den tatsächlich verwendeten Port zurück. */
  listen(port = this.config.port, host = this.config.host): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.close(1001, 'Server wird beendet');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.http.closeAllConnections();
    // Laufende Datenbank-Aufgaben abschließen lassen.
    await Promise.all([...this.rooms.values()].map((r) => r.run(async () => {})));
  }

  get connectionCount(): number {
    return this.wss.clients.size;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && pathOf(req) === '/health') {
      try {
        await this.store.ping();
        send(res, 200, { status: 'ok', connections: this.connectionCount });
      } catch {
        send(res, 503, { status: 'database unavailable' });
      }
      return;
    }
    try {
      if (this.web && (await serveWebApp(this.web, req, res))) return;
    } catch (e) {
      console.error('Fehler beim Ausliefern der Web-App:', e);
      if (!res.headersSent) send(res, 500, { status: 'error' });
      else res.destroy();
      return;
    }
    send(res, 404, { status: 'not found' });
  }

  private checkAlive(): void {
    for (const ws of this.wss.clients) {
      const conn = connOf.get(ws);
      if (!conn) continue;
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }

  private accept(ws: WebSocket): void {
    const conn: Connection = {
      ws,
      room: null,
      live: false,
      alive: true,
      tokens: this.config.messagesPerSecond * 10,
      refilledAt: Date.now(),
    };
    connOf.set(ws, conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => this.detach(conn));
    ws.on('error', () => ws.terminate());
  }

  private detach(conn: Connection): void {
    const room = conn.room;
    if (!room) return;
    room.conns.delete(conn);
    conn.room = null;
    this.dropRoomIfIdle(room);
  }

  private dropRoomIfIdle(room: Room): void {
    if (room.conns.size === 0 && room.pending === 0 && this.rooms.get(room.key) === room) {
      this.rooms.delete(room.key);
    }
  }

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    conn.alive = true;
    try {
      if (!isBinary) throw new ProtocolError(ErrorCode.badRequest, 'Nur Binärnachrichten');
      if (!this.takeToken(conn)) {
        throw new ProtocolError(ErrorCode.rateLimited, 'Zu viele Nachrichten');
      }
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const msg = decodeClientMessage(buf, this.config);
      this.handle(conn, msg);
    } catch (e) {
      this.fail(conn, e);
    }
  }

  private takeToken(conn: Connection): boolean {
    const now = Date.now();
    const rate = this.config.messagesPerSecond;
    conn.tokens = Math.min(rate * 10, conn.tokens + ((now - conn.refilledAt) / 1000) * rate);
    conn.refilledAt = now;
    if (conn.tokens < 1) return false;
    conn.tokens--;
    return true;
  }

  private fail(conn: Connection, e: unknown): void {
    if (e instanceof ProtocolError) {
      sendWs(conn.ws, encodeError(e.code, e.message));
    } else {
      console.error('Interner Fehler:', e);
      sendWs(conn.ws, encodeError(ErrorCode.internal, 'Interner Fehler'));
    }
    conn.ws.close(1008);
  }

  private handle(conn: Connection, msg: ClientMessage): void {
    switch (msg.op) {
      case Op.ping:
        sendWs(conn.ws, PONG);
        return;
      case Op.hello:
        this.hello(conn, msg.version, msg.vault, msg.lastSeq);
        return;
      case Op.push: {
        const room = this.requireRoom(conn);
        const { reqId, records } = msg;
        this.runIn(conn, room, async () => {
          const first = await this.store.put(room.id, records);
          if (first === null) {
            sendWs(conn.ws, VAULT_DELETED);
            return;
          }
          const stored: StoredRecord[] = records.map((r, i) => ({ ...r, seq: first + i }));
          const frame = encodeChanges(stored);
          for (const other of room.conns) {
            if (other !== conn && other.live) sendWs(other.ws, frame);
          }
          sendWs(conn.ws, encodeAck(reqId, first));
        });
        return;
      }
      case Op.deleteVault: {
        const room = this.requireRoom(conn);
        this.runIn(conn, room, async () => {
          await this.store.deleteVault(room.id);
          for (const c of [...room.conns]) {
            sendWs(c.ws, VAULT_DELETED);
            c.ws.close(1000);
          }
          if (!room.conns.has(conn)) {
            sendWs(conn.ws, VAULT_DELETED);
            conn.ws.close(1000);
          }
        });
        return;
      }
    }
  }

  private requireRoom(conn: Connection): Room {
    if (!conn.room) throw new ProtocolError(ErrorCode.badRequest, 'HELLO fehlt');
    return conn.room;
  }

  private hello(conn: Connection, version: number, vault: Buffer, lastSeq: number): void {
    if (conn.room) throw new ProtocolError(ErrorCode.badRequest, 'HELLO doppelt');
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolError(ErrorCode.unsupportedVersion, `Protokoll ${version} unbekannt`);
    }
    const id = vaultHash(vault);
    const key = id.toString('hex');
    let room = this.rooms.get(key);
    if (!room) {
      room = new Room(id);
      this.rooms.set(key, room);
    }
    const max = this.config.maxConnectionsPerVault;
    if (max > 0 && room.conns.size >= max) {
      this.dropRoomIfIdle(room);
      throw new ProtocolError(ErrorCode.tooManyConnections, 'Zu viele Geräte verbunden');
    }
    conn.room = room;
    room.conns.add(conn);
    const r = room;
    this.runIn(conn, r, async () => {
      const head = await this.store.head(r.id);
      if (head.deleted) {
        sendWs(conn.ws, VAULT_DELETED);
        conn.ws.close(1000);
        return;
      }
      let after = lastSeq;
      while (after < head.seq) {
        const chunk = await this.store.changesSince(r.id, after, CATCH_UP_CHUNK);
        if (chunk.length === 0) break;
        sendWs(conn.ws, encodeChanges(chunk));
        after = chunk[chunk.length - 1]!.seq;
      }
      sendWs(conn.ws, encodeSynced(head.seq));
      conn.live = true;
    });
  }

  /** Führt [task] in der Warteschlange des Vaults aus, solange die Verbindung offen ist. */
  private runIn(conn: Connection, room: Room, task: () => Promise<void>): void {
    room
      .run(async () => {
        if (conn.ws.readyState !== conn.ws.OPEN) return;
        await task();
      })
      .catch((e) => this.fail(conn, e))
      .finally(() => this.dropRoomIfIdle(room));
  }
}

const connOf = new WeakMap<WebSocket, Connection>();

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendWs(ws: WebSocket, data: Buffer): void {
  if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
}
