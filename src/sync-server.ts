import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import type { Config } from './config.ts';
import { IpLimiter, clientIp } from './limits.ts';
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
/** Obergrenze einer CHANGES-Nachricht beim Nachholen (mindestens ein Datensatz). */
const CATCH_UP_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** Wie oft abgelaufene Vaults entfernt werden. */
const EXPIRE_EVERY_MS = 60 * 60 * 1000;

/**
 * Zählt, warum Verbindungen abgelehnt oder getrennt wurden, und schreibt die
 * Summe gesammelt ins Log (höchstens eine Zeile pro Heartbeat-Intervall).
 */
export class DropStats {
  private readonly counts = new Map<string, number>();

  add(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  /** Liefert die Zählerstände seit dem letzten Aufruf und setzt sie zurück. */
  take(): Record<string, number> {
    const out = Object.fromEntries(this.counts);
    this.counts.clear();
    return out;
  }

  flush(log: (line: string) => void = console.log): void {
    const parts = Object.entries(this.take()).map(([k, v]) => `${k}=${v}`);
    if (parts.length > 0) log(`Verbindungen abgelehnt/getrennt: ${parts.join(', ')}`);
  }
}

const ERROR_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ErrorCode).map(([k, v]) => [v, k]),
);

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
  /** Client-IP (IPv6: /64), `undefined` wenn unbekannt → keine IP-Limits. */
  ip: string | undefined;
  helloTimer: NodeJS.Timeout | undefined;
}

export class SyncServer {
  private readonly rooms = new Map<string, Room>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout | undefined;
  private expiry: NodeJS.Timeout | undefined;
  private expiring: Promise<void> | null = null;
  private readonly config: Config;
  private readonly store: Store;

  private readonly web: WebApp | null;
  private readonly ipLimits: IpLimiter;
  private warnedUnknownIp = false;
  readonly drops = new DropStats();

  constructor(config: Config, store: Store, web: WebApp | null = null) {
    this.config = config;
    this.store = store;
    this.web = web;
    this.ipLimits = new IpLimiter(config);
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.maxMessageBytes,
      // Die Nutzdaten sind verschlüsselt und lassen sich nicht komprimieren.
      perMessageDeflate: false,
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (pathOf(req) !== '/sync') {
        this.drops.add('notFound');
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      const max = this.config.maxConnections;
      if (max > 0 && this.wss.clients.size >= max) {
        this.drops.add('serverFull');
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\n\r\n');
        return;
      }
      const ip = clientIp(req, this.config.clientIpHeader);
      if (ip === undefined) {
        if (!this.warnedUnknownIp) {
          this.warnedUnknownIp = true;
          console.warn('Client-IP unbekannt: Limits pro IP greifen nicht (CLIENT_IP_HEADER setzen).');
        }
      } else {
        if (!this.warnedUnknownIp && !this.config.clientIpHeader && (ip === '127.0.0.1' || ip === '0:0:0:0::/64')) {
          this.warnedUnknownIp = true;
          console.warn('Verbindung von localhost: Läuft der Server hinter einem Proxy, CLIENT_IP_HEADER setzen, sonst teilen sich alle Nutzer ein IP-Limit.');
        }
        const refused = this.ipLimits.connect(ip);
        if (refused) {
          this.drops.add(`ipLimit(${ip})`);
          socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n');
          return;
        }
      }
      // Ab hier ist die Verbindung pro IP gezählt und muss wieder freigegeben werden.
      let accepted = false;
      socket.once('close', () => {
        if (!accepted && ip !== undefined) this.ipLimits.disconnect(ip);
      });
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        accepted = true;
        this.accept(ws, ip);
      });
    });
  }

  /** Startet den Server; gibt den tatsächlich verwendeten Port zurück. */
  listen(port = this.config.port, host = this.config.host): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        this.heartbeat = setInterval(() => {
          this.checkAlive();
          this.ipLimits.sweep();
          this.drops.flush();
        }, HEARTBEAT_MS);
        if (this.config.vaultTtlDays > 0) {
          void this.expireVaults();
          this.expiry = setInterval(() => void this.expireVaults(), EXPIRE_EVERY_MS);
          this.expiry.unref();
        }
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    clearInterval(this.expiry);
    this.drops.flush();
    await this.expiring;
    for (const ws of this.wss.clients) ws.close(1001, 'Server wird beendet');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.http.closeAllConnections();
    // Laufende Datenbank-Aufgaben abschließen lassen.
    await Promise.all([...this.rooms.values()].map((r) => r.run(async () => {})));
  }

  /** Entfernt Vaults, die länger als `vaultTtlDays` niemand benutzt hat. */
  expireVaults(): Promise<void> {
    this.expiring ??= (async () => {
      try {
        const before = new Date(Date.now() - this.config.vaultTtlDays * 24 * 60 * 60 * 1000);
        const n = await this.store.expire(before);
        if (n > 0) console.log(`${n} unbenutzte Vaults entfernt.`);
      } catch (e) {
        console.error('Fehler beim Entfernen unbenutzter Vaults:', e);
      } finally {
        this.expiring = null;
      }
    })();
    return this.expiring;
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
        this.drops.add('heartbeatTimeout');
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }

  private accept(ws: WebSocket, ip: string | undefined): void {
    const conn: Connection = {
      ws,
      room: null,
      live: false,
      alive: true,
      tokens: this.config.messagesPerSecond * 10,
      refilledAt: Date.now(),
      ip,
      helloTimer: undefined,
    };
    if (this.config.helloTimeoutMs > 0) {
      conn.helloTimer = setTimeout(() => {
        if (!conn.room) {
          this.drops.add('helloTimeout');
          ws.close(1008, 'HELLO fehlt');
        }
      }, this.config.helloTimeoutMs);
      conn.helloTimer.unref();
    }
    connOf.set(ws, conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => {
      clearTimeout(conn.helloTimer);
      if (ip !== undefined) this.ipLimits.disconnect(ip);
      this.detach(conn);
    });
    ws.on('error', () => {
      this.drops.add('socketError');
      ws.terminate();
    });
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
      if (conn.ip !== undefined && !this.ipLimits.upload(conn.ip, buf.length)) {
        throw new ProtocolError(ErrorCode.rateLimited, 'Zu viele Daten von dieser Adresse, bitte später erneut');
      }
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
      this.drops.add(`error:${ERROR_NAMES[e.code] ?? e.code}`);
      this.sendWs(conn.ws, encodeError(e.code, e.message));
    } else {
      this.drops.add('error:internal');
      console.error('Interner Fehler:', e);
      this.sendWs(conn.ws, encodeError(ErrorCode.internal, 'Interner Fehler'));
    }
    conn.ws.close(1008);
  }

  private handle(conn: Connection, msg: ClientMessage): void {
    switch (msg.op) {
      case Op.ping:
        this.sendWs(conn.ws, PONG);
        return;
      case Op.hello:
        this.hello(conn, msg.version, msg.vault, msg.lastSeq);
        return;
      case Op.push: {
        const room = this.requireRoom(conn);
        const { reqId, records } = msg;
        this.runIn(conn, room, async () => {
          const first = await this.store.put(room.id, records, {
            maxRecords: this.config.maxVaultRecords,
            maxBytes: this.config.maxVaultBytes,
            maxTotalBytes: this.config.maxTotalBytes,
          });
          if (first === null) {
            this.sendWs(conn.ws, VAULT_DELETED);
            return;
          }
          const stored: StoredRecord[] = records.map((r, i) => ({ ...r, seq: first + i }));
          const frame = encodeChanges(stored);
          for (const other of room.conns) {
            if (other !== conn && other.live) this.sendWs(other.ws, frame);
          }
          this.sendWs(conn.ws, encodeAck(reqId, first));
        });
        return;
      }
      case Op.deleteVault: {
        const room = this.requireRoom(conn);
        this.runIn(conn, room, async () => {
          await this.store.deleteVault(room.id);
          for (const c of [...room.conns]) {
            this.sendWs(c.ws, VAULT_DELETED);
            c.ws.close(1000);
          }
          if (!room.conns.has(conn)) {
            this.sendWs(conn.ws, VAULT_DELETED);
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
    clearTimeout(conn.helloTimer);
    const r = room;
    this.runIn(conn, r, async () => {
      const head = await this.store.head(r.id);
      await this.store.touch(r.id);
      if (head.deleted) {
        this.sendWs(conn.ws, VAULT_DELETED);
        conn.ws.close(1000);
        return;
      }
      let after = lastSeq;
      while (after < head.seq) {
        const chunk = await this.store.changesSince(r.id, after, CATCH_UP_CHUNK);
        if (chunk.length === 0) break;
        // Jede Nachricht erst senden, wenn die vorige beim Socket angekommen ist:
        // Ein Client, der nicht liest, kann so nicht den ganzen Vault in den
        // Arbeitsspeicher des Servers ziehen.
        for (const frame of framesOf(chunk)) {
          if (!(await this.sendFlushed(conn.ws, frame))) return;
        }
        after = chunk[chunk.length - 1]!.seq;
      }
      this.sendWs(conn.ws, encodeSynced(head.seq));
      conn.live = true;
    });
  }

  /**
   * Sendet [data], solange der Client mitliest. Stauen sich mehr als
   * `maxSendBufferBytes` ungelesene Daten, wird die Verbindung getrennt; der
   * Client holt nach dem Wiederverbinden per HELLO nach.
   */
  private sendWs(ws: WebSocket, data: Buffer): void {
    if (ws.readyState !== ws.OPEN) return;
    const max = this.config.maxSendBufferBytes;
    if (max > 0 && ws.bufferedAmount > max) {
      this.drops.add('sendBufferFull');
      ws.terminate();
      return;
    }
    ws.send(data, { binary: true });
  }

  /**
   * Sendet [data] und wartet, bis die Nachricht an den Socket übergeben ist.
   * Liest der Client länger als `sendStallTimeoutMs` nicht, wird getrennt.
   * Liefert `false`, wenn die Verbindung dabei verloren ging.
   */
  private sendFlushed(ws: WebSocket, data: Buffer): Promise<boolean> {
    if (ws.readyState !== ws.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        ws.off('close', onClose);
        resolve(ok && ws.readyState === ws.OPEN);
      };
      const onClose = () => done(false);
      ws.once('close', onClose);
      const stall = this.config.sendStallTimeoutMs;
      if (stall > 0) {
        timer = setTimeout(() => {
          this.drops.add('sendStalled');
          ws.terminate();
        }, stall);
      }
      ws.send(data, { binary: true }, (err) => done(!err));
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

/** Teilt [records] in CHANGES-Nachrichten von höchstens [CATCH_UP_FRAME_BYTES]. */
function* framesOf(records: StoredRecord[]): Generator<Buffer> {
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < records.length; i++) {
    const size = records[i]!.data.length + 32;
    if (i > start && bytes + size > CATCH_UP_FRAME_BYTES) {
      yield encodeChanges(records.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
  }
  if (start < records.length) yield encodeChanges(records.slice(start));
}
