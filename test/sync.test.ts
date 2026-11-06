import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { loadConfig } from '../src/config.ts';
import { Database } from '../src/db.ts';
import { Op, Reader, encodeHello, encodePush } from '../src/protocol.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import { SyncServer } from '../src/sync-server.ts';

type ServerMsg =
  | { op: 'changes'; records: { seq: number; key: string; data: string }[] }
  | { op: 'synced'; head: number }
  | { op: 'ack'; reqId: number; first: number }
  | { op: 'pong' }
  | { op: 'deleted' }
  | { op: 'error'; code: number; message: string };

function decode(buf: Buffer): ServerMsg {
  const r = new Reader(buf);
  const op = r.u8();
  switch (op) {
    case Op.changes: {
      const n = r.varint();
      const records = [];
      for (let i = 0; i < n; i++) {
        const seq = r.varint();
        const key = r.bytes(16).toString('hex');
        const data = r.bytes(r.varint()).toString();
        records.push({ seq, key, data });
      }
      return { op: 'changes', records };
    }
    case Op.synced:
      return { op: 'synced', head: r.varint() };
    case Op.ack:
      return { op: 'ack', reqId: r.varint(), first: r.varint() };
    case Op.pong:
      return { op: 'pong' };
    case Op.vaultDeleted:
      return { op: 'deleted' };
    case Op.error:
      return { op: 'error', code: r.u8(), message: buf.subarray(2).toString() };
  }
  throw new Error(`unbekannt ${op}`);
}

/** Minimaler Test-Client, der alle Server-Nachrichten sammelt. */
class Client {
  readonly messages: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  private readonly ws: WebSocket;
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => {
      this.messages.push(decode(d as Buffer));
      this.wake();
    });
    ws.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  static async connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    await new Promise((res, rej) => ws.once('open', res).once('error', rej));
    return new Client(ws);
  }

  send(buf: Buffer) {
    this.ws.send(buf);
  }

  /** Wartet, bis eine Nachricht [pred] erfüllt, und gibt alle bis dahin zurück. */
  async until(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex(pred);
      if (i >= 0) return this.messages.splice(0, i + 1);
      if (this.closed) throw new Error('Verbindung geschlossen');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Zeitüberschreitung, erhalten: ${JSON.stringify(this.messages)}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, left);
      });
    }
  }

  async hello(vault: Buffer, lastSeq = 0) {
    this.send(encodeHello(vault, lastSeq));
    return this.until((m) => m.op === 'synced');
  }

  close() {
    this.ws.close();
  }
}

const key = (n: number) => Buffer.alloc(16, n);
const rec = (n: number, data: string) => ({ key: key(n), data: Buffer.from(data) });

function suite(name: string, makeStore: () => Promise<Store>) {
  describe(name, () => {
    let server: SyncServer;
    let store: Store;
    let port: number;

    before(async () => {
      store = await makeStore();
      server = new SyncServer({ ...loadConfig({}), messagesPerSecond: 1000 }, store);
      port = await server.listen(0, '127.0.0.1');
    });
    after(async () => {
      await server.close();
      await store.close();
    });

    test('Push wird an das zweite Gerät verteilt und nachgeholt', async () => {
      const vault = randomBytes(16);
      const a = await Client.connect(port);
      const b = await Client.connect(port);
      assert.deepEqual(await a.hello(vault), [{ op: 'synced', head: 0 }]);
      await b.hello(vault);

      a.send(encodePush(1, [rec(1, 'eins'), rec(2, 'zwei')]));
      assert.deepEqual(await a.until((m) => m.op === 'ack'), [{ op: 'ack', reqId: 1, first: 1 }]);
      assert.deepEqual(await b.until((m) => m.op === 'changes'), [
        {
          op: 'changes',
          records: [
            { seq: 1, key: key(1).toString('hex'), data: 'eins' },
            { seq: 2, key: key(2).toString('hex'), data: 'zwei' },
          ],
        },
      ]);

      // Überschreiben: nur der neueste Stand je Schlüssel bleibt.
      b.send(encodePush(7, [rec(1, 'EINS')]));
      assert.deepEqual(await b.until((m) => m.op === 'ack'), [{ op: 'ack', reqId: 7, first: 3 }]);
      await a.until((m) => m.op === 'changes');

      // Neues Gerät holt alles nach, ein Gerät mit Stand 2 nur die Änderung.
      const c = await Client.connect(port);
      const all = await c.hello(vault);
      assert.deepEqual(all, [
        {
          op: 'changes',
          records: [
            { seq: 2, key: key(2).toString('hex'), data: 'zwei' },
            { seq: 3, key: key(1).toString('hex'), data: 'EINS' },
          ],
        },
        { op: 'synced', head: 3 },
      ]);
      const d = await Client.connect(port);
      const delta = await d.hello(vault, 2);
      assert.equal(delta.length, 2);
      assert.deepEqual(delta[0], {
        op: 'changes',
        records: [{ seq: 3, key: key(1).toString('hex'), data: 'EINS' }],
      });
      for (const x of [a, b, c, d]) x.close();
    });

    test('Vaults sind voneinander getrennt', async () => {
      const a = await Client.connect(port);
      const b = await Client.connect(port);
      await a.hello(randomBytes(16));
      await b.hello(randomBytes(16));
      a.send(encodePush(1, [rec(1, 'x')]));
      await a.until((m) => m.op === 'ack');
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(b.messages, []);
      a.close();
      b.close();
    });

    test('Löschen trennt alle Geräte und verbrennt den Code', async () => {
      const vault = randomBytes(16);
      const a = await Client.connect(port);
      const b = await Client.connect(port);
      await a.hello(vault);
      await b.hello(vault);
      a.send(encodePush(1, [rec(1, 'x')]));
      await a.until((m) => m.op === 'ack');
      a.send(Buffer.from([Op.deleteVault]));
      await a.until((m) => m.op === 'deleted');
      await b.until((m) => m.op === 'deleted');

      const c = await Client.connect(port);
      c.send(encodeHello(vault, 0));
      assert.deepEqual(await c.until((m) => m.op === 'deleted'), [{ op: 'deleted' }]);
    });

    test('PING, fehlendes HELLO und falsche Version', async () => {
      const a = await Client.connect(port);
      a.send(Buffer.from([Op.ping]));
      assert.deepEqual(await a.until(() => true), [{ op: 'pong' }]);
      a.send(encodePush(1, [rec(1, 'x')]));
      const [err] = await a.until((m) => m.op === 'error');
      assert.equal(err?.op, 'error');

      const b = await Client.connect(port);
      b.send(encodeHello(randomBytes(16), 0, 99));
      const [err2] = await b.until((m) => m.op === 'error');
      assert.deepEqual(err2 && err2.op === 'error' && err2.code, 2);
    });
  });
}

suite('Sync-Server (Arbeitsspeicher)', async () => new MemoryStore());

// Gegen MySQL nur, wenn eine Test-Datenbank angegeben ist:
//   TEST_DATABASE_URL=mysql://antatime:antatime@127.0.0.1:3306/antatime npm test
const dbUrl = process.env['TEST_DATABASE_URL'];
if (dbUrl) {
  suite('Sync-Server (MySQL)', async () => {
    const db = new Database(loadConfig({ DATABASE_URL: dbUrl }).db);
    await db.init(5);
    return db;
  });
}
