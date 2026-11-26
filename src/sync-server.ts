import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import type { Config } from './config.ts';
import { IpLimiter, TrustedProxies, clientIp } from './limits.ts';
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
import { serveUpdates } from './updates.ts';
import type { Updates } from './updates.ts';
import { serveWebApp } from './web-app.ts';
import type { WebApp } from './web-app.ts';

/** Datensätze pro CHANGES-Nachricht beim Nachholen. */
const CATCH_UP_CHUNK = 500;
/** Obergrenze einer CHANGES-Nachricht beim Nachholen (mindestens ein Datensatz). */
const CATCH_UP_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** Wie oft abgelaufene Vaults entfernt werden. */
const EXPIRE_EVERY_MS = 60 * 60 * 1000;
/** So lange gilt ein `/health`-Ergebnis, damit Abfragen die Datenbank nicht fluten. */
const HEALTH_CACHE_MS = 2000;
/** Abgelehnte Upgrade-Sockets werden spätestens danach geschlossen. */
const REJECT_CLOSE_MS = 1000;
/**
 * Nachholen außerhalb der Warteschlange: Fehlen danach noch mehr Datensätze als
 * das, läuft eine weitere Runde außerhalb, bevor der Rest in der Warteschlange
 * nachgeschickt wird (höchstens [CATCH_UP_ROUNDS] Runden).
 */
const CATCH_UP_TAIL = CATCH_UP_CHUNK;
const CATCH_UP_ROUNDS = 3;
/**
 * Unbestätigte PUSHes pro Verbindung (Anzahl bzw. Bytes). Darüber wird mit
 * `rateLimited` getrennt, sonst könnte ein Client bei langsamer Datenbank
 * beliebig viel in der Warteschlange seines Vaults parken.
 */
export const MAX_QUEUED_PUSHES = 8;
export const MAX_QUEUED_PUSH_BYTES = 16 * 1024 * 1024;

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
  /** PUSHes in der Warteschlange des Vaults (laufend oder wartend) und ihre Größe. */
  queued: number;
  queuedBytes: number;
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
  private readonly updates: Updates | null;
  private readonly ipLimits: IpLimiter;
  private readonly trustedProxies: TrustedProxies;
  private health: { at: number; ok: Promise<boolean> } | null = null;
  /** Laufendes Nachholen außerhalb der Warteschlangen; `close()` wartet darauf. */
  private readonly catchUps = new Set<Promise<void>>();
  /**
   * Angenommene Upgrade-Sockets bis zu ihrem Schließen. `wss.clients` enthält
   * Upgrades, die noch laufen, nicht und taugt daher nicht für `maxConnections`.
   */
  private sockets = 0;
  private warnedUnknownIp = false;
  private warnedUntrusted = false;
  readonly drops = new DropStats();

  constructor(
    config: Config,
    store: Store,
    web: WebApp | null = null,
    updates: Updates | null = null,
  ) {
    this.config = config;
    this.store = store;
    this.web = web;
    this.updates = updates;
    this.ipLimits = new IpLimiter(config);
    this.trustedProxies = new TrustedProxies(config.trustedProxies);
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.maxMessageBytes,
      // Die Nutzdaten sind verschlüsselt und lassen sich nicht komprimieren.
      perMessageDeflate: false,
    });
    this.http.on('upgrade', (req, socket, head) => {
      // Node entfernt vor 'upgrade' seinen eigenen Fehler-Listener: Ohne diesen
      // würde z. B. ein ECONNRESET beim Ablehnen den ganzen Prozess beenden.
      socket.on('error', () => socket.destroy());
      if (pathOf(req) !== '/sync') {
        this.drops.add('notFound');
        reject(socket, 'HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      const max = this.config.maxConnections;
      if (max > 0 && this.sockets >= max) {
        this.drops.add('serverFull');
        reject(socket, 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\n\r\n');
        return;
      }
      const ip = clientIp(req, this.config.clientIpHeader, this.trustedProxies);
      const from = req.socket.remoteAddress;
      if (!this.warnedUntrusted && this.config.clientIpHeader && from && !this.trustedProxies.has(from)) {
        this.warnedUntrusted = true;
        console.warn(
          `CLIENT_IP_HEADER ignoriert: Verbindung von ${from} steht nicht in TRUSTED_PROXIES (Proxy eintragen, falls er dort fehlt).`,
        );
      }
      if (ip === undefined) {
        if (!this.warnedUnknownIp) {
          this.warnedUnknownIp = true;
          console.warn(
            'Client-IP unbekannt: Limits pro IP greifen nicht (CLIENT_IP_HEADER setzen).',
            describeIpSources(req, this.config.clientIpHeader),
          );
        }
      } else {
        if (!this.warnedUnknownIp && !this.config.clientIpHeader && (ip === '127.0.0.1' || ip === '0:0:0:0::/64')) {
          this.warnedUnknownIp = true;
          console.warn(
            'Verbindung von localhost: Läuft der Server hinter einem Proxy, CLIENT_IP_HEADER setzen, sonst teilen sich alle Nutzer ein IP-Limit.',
            describeIpSources(req, this.config.clientIpHeader),
          );
        }
        const refused = this.ipLimits.connect(ip);
        if (refused) {
          // Ohne IP im Schlüssel: Bei vielen Adressen wüchse die Statistik sonst unbegrenzt.
          this.drops.add('ipLimit');
          reject(socket, 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n');
          return;
        }
      }
      // Ab hier ist die Verbindung pro IP gezählt und muss wieder freigegeben werden.
      let accepted = false;
      this.sockets++;
      socket.once('close', () => {
        this.sockets--;
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
    await Promise.all(this.catchUps);
    await Promise.all([...this.rooms.values()].map((r) => r.run(async () => {})));
  }

  /** Entfernt Vaults, die länger als `vaultTtlDays` niemand benutzt hat. */
  expireVaults(): Promise<void> {
    this.expiring ??= (async () => {
      try {
        const before = new Date(Date.now() - this.config.vaultTtlDays * 24 * 60 * 60 * 1000);
        // Vaults mit Verbindungen oder offenen Aufgaben bleiben, sonst finge ein
        // verbundenes Gerät unbemerkt in einer neuen Epoche an.
        const n = await this.store.expire(before, (id) => this.rooms.has(id.toString('hex')));
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
      if (await this.checkHealth()) send(res, 200, { status: 'ok', connections: this.connectionCount });
      else send(res, 503, { status: 'database unavailable' });
      return;
    }
    try {
      if (this.updates && (await serveUpdates(this.updates, req, res))) return;
      if (this.web && (await serveWebApp(this.web, req, res))) return;
    } catch (e) {
      console.error('Fehler beim Ausliefern von Web-App oder Updates:', e);
      if (!res.headersSent) send(res, 500, { status: 'error' });
      else res.destroy();
      return;
    }
    send(res, 404, { status: 'not found' });
  }

  /**
   * Datenbank erreichbar? Das Ergebnis gilt [HEALTH_CACHE_MS] lang, gleichzeitige
   * Anfragen teilen sich eine Abfrage – `/health` ist ohne Limit öffentlich.
   */
  private checkHealth(): Promise<boolean> {
    const now = Date.now();
    if (!this.health || now - this.health.at >= HEALTH_CACHE_MS) {
      this.health = {
        at: now,
        ok: this.store.ping().then(
          () => true,
          () => false,
        ),
      };
    }
    return this.health.ok;
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
      queued: 0,
      queuedBytes: 0,
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
    if (rate === 0) return true;
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
        const bytes = records.reduce((sum, r) => sum + r.key.length + r.data.length, 0);
        // Ein einzelner PUSH geht immer, auch wenn er größer als das Byte-Limit ist.
        if (
          conn.queued >= MAX_QUEUED_PUSHES ||
          (conn.queued > 0 && conn.queuedBytes + bytes > MAX_QUEUED_PUSH_BYTES)
        ) {
          throw new ProtocolError(ErrorCode.rateLimited, 'Zu viele unbestätigte Änderungen');
        }
        conn.queued++;
        conn.queuedBytes += bytes;
        // Bei geschlossener Verbindung entfällt die Aufgabe samt Freigabe – egal.
        this.runIn(conn, room, async () => {
          try {
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
          } finally {
            conn.queued--;
            conn.queuedBytes -= bytes;
          }
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
    // Nur den Stand lesen geht in die Warteschlange. Das eigentliche Nachholen
    // läuft außerhalb, sonst hielte ein langsamer Client PUSH/ACK aller
    // anderen Geräte des Vaults auf.
    this.runIn(conn, r, async () => {
      // Erst anlegen, dann lesen: So trägt schon das erste SYNCED die Epoche,
      // die auch nach dem ersten PUSH noch gilt.
      await this.store.touch(r.id);
      const head = await this.store.head(r.id);
      if (head.deleted) {
        this.sendWs(conn.ws, VAULT_DELETED);
        conn.ws.close(1000);
        return;
      }
      this.track(this.catchUp(conn, r, lastSeq, head.seq));
    });
  }

  private track(task: Promise<void>): void {
    this.catchUps.add(task);
    void task.finally(() => this.catchUps.delete(task));
  }

  /**
   * Holt bis [target] außerhalb der Warteschlange nach (ggf. in mehreren
   * Runden, falls währenddessen viel dazukam). Den Rest schickt ein letzter
   * Schritt in der Warteschlange, der auch SYNCED sendet und die Verbindung
   * live schaltet: Dazwischen kann kein PUSH laufen, also geht keine Änderung
   * verloren und keine kommt doppelt oder außer der Reihe.
   */
  private async catchUp(conn: Connection, room: Room, lastSeq: number, target: number): Promise<void> {
    try {
      let after = lastSeq;
      for (let round = 0; round < CATCH_UP_ROUNDS; round++) {
        const reached = await this.sendChanges(conn, room, after, target);
        if (reached === null) return;
        after = reached;
        // Gelöschte Vaults haben keine Datensätze mehr; das klärt der letzte Schritt.
        const head = await this.store.head(room.id);
        if (head.deleted || head.seq - after <= CATCH_UP_TAIL) break;
        target = head.seq;
      }
      this.runIn(conn, room, async () => {
        const head = await this.store.head(room.id);
        if (head.deleted) {
          this.sendWs(conn.ws, VAULT_DELETED);
          conn.ws.close(1000);
          return;
        }
        if ((await this.sendChanges(conn, room, after, head.seq)) === null) return;
        this.sendWs(conn.ws, encodeSynced(head.seq, head.epoch));
        conn.live = true;
      });
    } catch (e) {
      this.fail(conn, e);
    }
  }

  /**
   * Sendet die Datensätze mit `after < seq <= upTo` in Sequenz-Reihenfolge.
   * Liefert die zuletzt erreichte Sequenznummer bzw. `null`, wenn die
   * Verbindung dabei verloren ging oder den Raum verlassen hat.
   */
  private async sendChanges(conn: Connection, room: Room, after: number, upTo: number): Promise<number | null> {
    while (after < upTo) {
      if (conn.room !== room) return null;
      const chunk = (await this.store.changesSince(room.id, after, CATCH_UP_CHUNK)).filter((c) => c.seq <= upTo);
      if (chunk.length === 0) break;
      // Jede Nachricht erst senden, wenn die vorige beim Socket angekommen ist:
      // Ein Client, der nicht liest, kann so nicht den ganzen Vault in den
      // Arbeitsspeicher des Servers ziehen.
      for (const frame of framesOf(chunk)) {
        if (!(await this.sendFlushed(conn.ws, frame))) return null;
      }
      after = chunk[chunk.length - 1]!.seq;
    }
    return conn.room === room ? after : null;
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

/**
 * Was der Server über die Herkunft einer Anfrage weiß – für die Warnung,
 * wenn die Client-IP fehlt: Socket-Adresse, eingestellter Header und alle
 * Header, die typischerweise die Client-IP tragen, sowie die Namen aller
 * übrigen Header (ohne Werte).
 */
export function describeIpSources(req: IncomingMessage, header: string): string {
  const ipHeader = /forwarded|real-ip|client-ip|connecting-ip|client-addr/i;
  const ipHeaders: string[] = [];
  const others: string[] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (ipHeader.test(name)) ipHeaders.push(`${name}=${String(value)}`);
    else others.push(name);
  }
  return [
    `Socket: ${req.socket.remoteAddress ?? '–'}`,
    `CLIENT_IP_HEADER: ${header || '–'}`,
    `IP-Header: ${ipHeaders.join(', ') || '–'}`,
    `weitere Header: ${others.join(', ') || '–'}`,
  ].join('; ');
}

/**
 * Lehnt ein Upgrade ab. Upgrade-Sockets sind halboffen (`allowHalfOpen`) und
 * blieben nach `end()` offen, solange der Client nicht selbst schließt.
 */
function reject(socket: Duplex, response: string): void {
  socket.end(response);
  const timer = setTimeout(() => socket.destroy(), REJECT_CLOSE_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

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
