/**
 * Binäres Sync-Protokoll (Version 1) über WebSocket.
 *
 * Jede Nachricht ist ein Binär-Frame; das erste Byte ist der Opcode.
 * `varint` = vorzeichenlose LEB128-Zahl, `key` = 16 Byte.
 *
 * Client → Server
 *   0x01 HELLO         u8 version, vault[16], varint lastSeq
 *   0x02 PUSH          varint reqId, varint n, n × { key, varint len, data }
 *   0x03 DELETE_VAULT
 *   0x04 PING
 *
 * Server → Client
 *   0x81 CHANGES       varint n, n × { varint seq, key, varint len, data }
 *   0x82 SYNCED        varint headSeq, [varint serverTime], [varint epoch]
 *                      Nachholen abgeschlossen. serverTime = Uhrzeit des Servers
 *                      in ms seit 1970, damit Clients eine falsch gehende
 *                      Geräteuhr erkennen. epoch = Kennung der Vault-Generation:
 *                      wechselt, wenn der Vault neu angelegt wird (etwa nach dem
 *                      Ablauf); 0 = Vault von vor den Epochen. Weicht sie von
 *                      der gemerkten ab, gilt lastSeq nicht mehr – der Client
 *                      holt ab 0 nach und lädt seine Daten neu hoch. Der Server
 *                      sendet immer beide Felder; ältere Clients ignorieren sie.
 *   0x83 ACK           varint reqId, varint firstSeq (Seqs firstSeq … firstSeq+n−1)
 *   0x84 PONG
 *   0x85 VAULT_DELETED
 *   0x8F ERROR         u8 code, UTF-8-Text
 *
 * Der Server kennt weder den Sync-Code noch die Schlüssel: `vault` und `key`
 * sind vom Client abgeleitete Zufallswerte, `data` ist AES-GCM-Chiffretext.
 */

export const PROTOCOL_VERSION = 1;
export const KEY_LENGTH = 16;
export const VAULT_ID_LENGTH = 16;

export const Op = {
  hello: 0x01,
  push: 0x02,
  deleteVault: 0x03,
  ping: 0x04,
  changes: 0x81,
  synced: 0x82,
  ack: 0x83,
  pong: 0x84,
  vaultDeleted: 0x85,
  error: 0x8f,
} as const;

export const ErrorCode = {
  badRequest: 1,
  unsupportedVersion: 2,
  tooLarge: 3,
  rateLimited: 4,
  tooManyConnections: 5,
  internal: 6,
  quotaExceeded: 7,
} as const;

export class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SyncRecord {
  key: Buffer;
  data: Buffer;
}

export interface StoredRecord extends SyncRecord {
  seq: number;
}

export type ClientMessage =
  | { op: typeof Op.hello; version: number; vault: Buffer; lastSeq: number }
  | { op: typeof Op.push; reqId: number; records: SyncRecord[] }
  | { op: typeof Op.deleteVault }
  | { op: typeof Op.ping };

// ---------------------------------------------------------------------------
// Lesen

export class Reader {
  private pos = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw bad('Nachricht zu kurz');
    return this.buf[this.pos++]!;
  }

  varint(): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw bad('Zahl zu groß');
        return result;
      }
      factor *= 128;
    }
    throw bad('Zahl zu groß');
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw bad('Nachricht zu kurz');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function bad(message: string): ProtocolError {
  return new ProtocolError(ErrorCode.badRequest, message);
}

export interface Limits {
  maxRecordBytes: number;
  maxRecordsPerPush: number;
}

export function decodeClientMessage(buf: Buffer, limits: Limits): ClientMessage {
  const r = new Reader(buf);
  const op = r.u8();
  let msg: ClientMessage;
  switch (op) {
    case Op.hello: {
      const version = r.u8();
      const vault = Buffer.from(r.bytes(VAULT_ID_LENGTH));
      const lastSeq = r.varint();
      msg = { op, version, vault, lastSeq };
      break;
    }
    case Op.push: {
      const reqId = r.varint();
      const n = r.varint();
      if (n === 0) throw bad('Leerer Push');
      if (n > limits.maxRecordsPerPush) {
        throw new ProtocolError(ErrorCode.tooLarge, 'Zu viele Datensätze');
      }
      const records: SyncRecord[] = [];
      for (let i = 0; i < n; i++) {
        const key = Buffer.from(r.bytes(KEY_LENGTH));
        const len = r.varint();
        if (len > limits.maxRecordBytes) {
          throw new ProtocolError(ErrorCode.tooLarge, 'Datensatz zu groß');
        }
        records.push({ key, data: Buffer.from(r.bytes(len)) });
      }
      msg = { op, reqId, records };
      break;
    }
    case Op.deleteVault:
    case Op.ping:
      msg = { op };
      break;
    default:
      throw bad(`Unbekannter Opcode ${op}`);
  }
  if (!r.done) throw bad('Überzählige Bytes');
  return msg;
}

// ---------------------------------------------------------------------------
// Schreiben

export class Writer {
  private chunks: Buffer[] = [];
  private cur = Buffer.allocUnsafe(256);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.cur.length) return;
    this.chunks.push(this.cur.subarray(0, this.pos));
    this.cur = Buffer.allocUnsafe(Math.max(256, n));
    this.pos = 0;
  }

  u8(v: number): this {
    this.ensure(1);
    this.cur[this.pos++] = v;
    return this;
  }

  varint(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`varint ${v}`);
    this.ensure(8);
    while (v >= 0x80) {
      this.cur[this.pos++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.cur[this.pos++] = v;
    return this;
  }

  bytes(b: Uint8Array): this {
    if (b.length > 64) {
      // Große Blöcke nicht kopieren.
      this.chunks.push(this.cur.subarray(0, this.pos));
      this.chunks.push(Buffer.from(b.buffer, b.byteOffset, b.length));
      this.cur = Buffer.allocUnsafe(256);
      this.pos = 0;
      return this;
    }
    this.ensure(b.length);
    this.cur.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  finish(): Buffer {
    this.chunks.push(this.cur.subarray(0, this.pos));
    return Buffer.concat(this.chunks);
  }
}

export function encodeChanges(records: StoredRecord[]): Buffer {
  const w = new Writer().u8(Op.changes).varint(records.length);
  for (const rec of records) {
    w.varint(rec.seq).bytes(rec.key).varint(rec.data.length).bytes(rec.data);
  }
  return w.finish();
}

export function encodeSynced(headSeq: number, epoch: number, serverTime = Date.now()): Buffer {
  return new Writer().u8(Op.synced).varint(headSeq).varint(serverTime).varint(epoch).finish();
}

export function encodeAck(reqId: number, firstSeq: number): Buffer {
  return new Writer().u8(Op.ack).varint(reqId).varint(firstSeq).finish();
}

export const PONG = Buffer.from([Op.pong]);
export const VAULT_DELETED = Buffer.from([Op.vaultDeleted]);

export function encodeError(code: number, message: string): Buffer {
  return Buffer.concat([Buffer.from([Op.error, code]), Buffer.from(message, 'utf8')]);
}

// Für Tests und Werkzeuge: Client-Nachrichten kodieren.

export function encodeHello(vault: Buffer, lastSeq: number, version = PROTOCOL_VERSION): Buffer {
  return new Writer().u8(Op.hello).u8(version).bytes(vault).varint(lastSeq).finish();
}

export function encodePush(reqId: number, records: SyncRecord[]): Buffer {
  const w = new Writer().u8(Op.push).varint(reqId).varint(records.length);
  for (const rec of records) w.bytes(rec.key).varint(rec.data.length).bytes(rec.data);
  return w.finish();
}
