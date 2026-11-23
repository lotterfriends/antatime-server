import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { loadConfig } from '../src/config.ts';
import { Database } from '../src/db.ts';
import { DEFAULT_TRUSTED_PROXIES, TrustedProxies, clientIp, ipKey } from '../src/limits.ts';
import { Op, Reader, encodeHello, encodePush } from '../src/protocol.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import {
  DropStats,
  MAX_QUEUED_PUSHES,
  MAX_QUEUED_PUSH_BYTES,
  SyncServer,
  describeIpSources,
  vaultHash,
} from '../src/sync-server.ts';

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
    case Op.synced: {
      // serverTime und Epoche müssen immer dabei sein; die Epoche liest syncedEpoch().
      const head = r.varint();
      r.varint();
      r.varint();
      assert.ok(r.done);
      return { op: 'synced', head };
    }
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

function syncedEpoch(buf: Buffer): number {
  const r = new Reader(buf);
  r.u8();
  r.varint();
  r.varint();
  return r.varint();
}

/** Minimaler Test-Client, der alle Server-Nachrichten sammelt. */
class Client {
  readonly messages: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  private readonly ws: WebSocket;
  closed = false;
  /** Epoche aus dem letzten SYNCED. */
  epoch: number | undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => {
      const m = decode(d as Buffer);
      if (m.op === 'synced') this.epoch = syncedEpoch(d as Buffer);
      this.messages.push(m);
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

  static async connect(port: number, headers: Record<string, string> = {}): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, { headers });
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

    test('Epoche bleibt gleich und wechselt, wenn der Vault neu angelegt wird', async () => {
      const vault = randomBytes(16);
      const a = await Client.connect(port);
      await a.hello(vault);
      const first = a.epoch!;
      assert.ok(first > 0 && first < 2 ** 48);
      a.send(encodePush(1, [rec(1, 'eins')]));
      await a.until((m) => m.op === 'ack');
      const b = await Client.connect(port);
      await b.hello(vault, 1);
      assert.equal(b.epoch, first);
      a.close();
      b.close();
      await a.until(() => false, 200).catch(() => {});

      // Nur diesen Vault ablaufen lassen (die Datenbank kann weitere enthalten).
      const id = vaultHash(vault);
      assert.equal(await store.expire(new Date(Date.now() + 60_000), (v) => !v.equals(id)), 1);

      // Ein Gerät mit altem Stand sieht an der neuen Epoche, dass lastSeq nicht mehr gilt.
      const c = await Client.connect(port);
      assert.deepEqual(await c.hello(vault, 1), [{ op: 'synced', head: 0 }]);
      assert.ok(c.epoch! > 0 && c.epoch !== first);
      c.send(encodePush(1, [rec(2, 'zwei')]));
      assert.deepEqual(await c.until((m) => m.op === 'ack'), [{ op: 'ack', reqId: 1, first: 1 }]);
      const d = await Client.connect(port);
      await d.hello(vault);
      assert.equal(d.epoch, c.epoch);
      c.close();
      d.close();
    });

    test('Kontingent pro Vault: Anzahl und Bytes', async () => {
      const limited = new SyncServer(
        { ...loadConfig({}), messagesPerSecond: 1000, maxVaultRecords: 2, maxVaultBytes: 10 },
        store,
      );
      const p = await limited.listen(0, '127.0.0.1');
      try {
        const vault = randomBytes(16);
        const a = await Client.connect(p);
        await a.hello(vault);
        a.send(encodePush(1, [rec(1, 'aaaa'), rec(2, 'bbbb')]));
        await a.until((m) => m.op === 'ack');
        // Überschreiben vorhandener Schlüssel geht, solange es nicht größer wird.
        a.send(encodePush(2, [rec(1, 'cc')]));
        await a.until((m) => m.op === 'ack');
        a.send(encodePush(3, [rec(3, 'x')]));
        const [err] = await a.until((m) => m.op === 'error');
        assert.equal(err?.op === 'error' && err.code, 7);

        const b = await Client.connect(p);
        await b.hello(vault, 3);
        b.send(encodePush(1, [rec(2, 'bbbbbbbbbb')]));
        const [err2] = await b.until((m) => m.op === 'error');
        assert.equal(err2?.op === 'error' && err2.code, 7);

        // Verkleinern ist trotz vollem Kontingent erlaubt, danach ist wieder Platz.
        const c = await Client.connect(p);
        await c.hello(vault, 3);
        c.send(encodePush(1, [rec(2, '')]));
        await c.until((m) => m.op === 'ack');
        c.send(encodePush(2, [rec(2, 'dddddd')]));
        await c.until((m) => m.op === 'ack');
      } finally {
        await limited.close();
      }
    });
  });
}

suite('Sync-Server (Arbeitsspeicher)', async () => new MemoryStore());

test('Trennungsgründe werden gesammelt geloggt', () => {
  const stats = new DropStats();
  const lines: string[] = [];
  const log = (l: string) => void lines.push(l);
  stats.flush(log);
  assert.deepEqual(lines, []);
  stats.add('heartbeatTimeout');
  stats.add('heartbeatTimeout');
  stats.add('error:quotaExceeded');
  stats.flush(log);
  stats.flush(log);
  assert.deepEqual(lines, ['Verbindungen abgelehnt/getrennt: heartbeatTimeout=2, error:quotaExceeded=1']);
});

test('Warnung ohne Client-IP nennt die vorhandenen Header', () => {
  const req = {
    headers: { host: 'antatime.de', 'x-forwarded-for': '203.0.113.5', upgrade: 'websocket' },
    socket: { remoteAddress: undefined },
  } as unknown as Parameters<typeof describeIpSources>[0];
  assert.equal(
    describeIpSources(req, 'x-real-ip'),
    'Socket: –; CLIENT_IP_HEADER: x-real-ip; IP-Header: x-forwarded-for=203.0.113.5; weitere Header: host, upgrade',
  );
});

describe('Limits pro IP', () => {
  async function start(overrides: Partial<ReturnType<typeof loadConfig>>) {
    const server = new SyncServer({ ...loadConfig({}), ...overrides }, new MemoryStore());
    return { server, port: await server.listen(0, '127.0.0.1') };
  }

  test('IPv6 wird auf /64 zusammengefasst', () => {
    assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipKey('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(ipKey('192.0.2.1'), '192.0.2.1');
  });

  test('vertrauenswürdige Proxys: IPs, CIDR, IPv4-mapped IPv6', () => {
    const def = new TrustedProxies(DEFAULT_TRUSTED_PROXIES);
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '::ffff:10.0.0.1', '172.31.255.255', '192.168.1.1', 'fd00::1']) {
      assert.ok(def.has(ip), ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:8.8.8.8', '2001:db8::1', 'fe80::1', '']) {
      assert.ok(!def.has(ip), ip);
    }
    const own = new TrustedProxies(['203.0.113.7', '2001:db8::/32', '198.51.100.0/24']);
    assert.ok(own.has('203.0.113.7'));
    assert.ok(own.has('::ffff:198.51.100.200'));
    assert.ok(own.has('2001:db8:ffff::1'));
    assert.ok(!own.has('203.0.113.8'));
    assert.ok(!own.has('127.0.0.1'));

    assert.deepEqual(loadConfig({}).trustedProxies, DEFAULT_TRUSTED_PROXIES);
    assert.deepEqual(loadConfig({ TRUSTED_PROXIES: ' 10.0.0.1, fc00::/7 ' }).trustedProxies, ['10.0.0.1', 'fc00::/7']);
    for (const bad of ['proxy.local', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.0/x']) {
      assert.throws(() => loadConfig({ TRUSTED_PROXIES: bad }), /TRUSTED_PROXIES/, bad);
    }

    const req = (remoteAddress: string | undefined) =>
      ({ headers: { 'x-real-ip': '203.0.113.9' }, socket: { remoteAddress } }) as unknown as Parameters<typeof clientIp>[0];
    assert.equal(clientIp(req('::ffff:192.168.0.2'), 'x-real-ip', def), '203.0.113.9');
    assert.equal(clientIp(req('198.51.100.1'), 'x-real-ip', def), '198.51.100.1');
    assert.equal(clientIp(req(undefined), 'x-real-ip', def), '203.0.113.9'); // Unix-Socket
    assert.equal(clientIp(req('10.0.0.1'), '', def), '10.0.0.1');
  });

  test('gleichzeitige Verbindungen pro IP, Freigabe beim Trennen', async () => {
    const { server, port } = await start({ maxConnectionsPerIp: 2 });
    try {
      const a = await Client.connect(port);
      await Client.connect(port);
      await assert.rejects(Client.connect(port), /429/);
      // Andere Adresse laut Proxy-Header ist davon nicht betroffen:
      const { server: s2, port: p2 } = await start({ maxConnectionsPerIp: 1, clientIpHeader: 'x-forwarded-for' });
      try {
        await Client.connect(p2, { 'x-forwarded-for': '1.1.1.1, 203.0.113.5' });
        await assert.rejects(Client.connect(p2, { 'x-forwarded-for': '203.0.113.5' }), /429/);
        await Client.connect(p2, { 'x-forwarded-for': '203.0.113.6' });
      } finally {
        await s2.close();
      }
      a.close();
      await a.until(() => false, 200).catch(() => {});
      await Client.connect(port);
    } finally {
      await server.close();
    }
  });

  test('Verbindungsaufbau pro Minute', async () => {
    const { server, port } = await start({ connectsPerIpPerMinute: 3 });
    try {
      for (let i = 0; i < 3; i++) (await Client.connect(port)).close();
      await assert.rejects(Client.connect(port), /429/);
      assert.deepEqual(server.drops.take(), { ipLimit: 1 });
    } finally {
      await server.close();
    }
  });

  test('Upload-Bytes pro IP', async () => {
    const { server, port } = await start({
      messagesPerSecond: 1000,
      maxMessageBytes: 2000,
      uploadBytesPerIpPerMinute: 2000,
    });
    try {
      const a = await Client.connect(port);
      await a.hello(randomBytes(16));
      a.send(encodePush(1, [rec(1, 'x'.repeat(1500))]));
      await a.until((m) => m.op === 'ack');
      a.send(encodePush(2, [rec(2, 'x'.repeat(1500))]));
      const [err] = await a.until((m) => m.op === 'error');
      assert.equal(err?.op === 'error' && err.code, 4);
    } finally {
      await server.close();
    }
  });

  /** Verbindung, die nach dem HELLO nichts mehr liest. */
  async function deafClient(port: number, vault: Buffer): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    await new Promise((res, rej) => ws.once('open', res).once('error', rej));
    ws.send(encodeHello(vault, 0));
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  }

  async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error('Zeitüberschreitung');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function fill(port: number, vault: Buffer, records: number) {
    const a = await Client.connect(port);
    await a.hello(vault);
    const data = 'x'.repeat(16 * 1024);
    for (let i = 0; i < records; i += 200) {
      const batch = [];
      for (let j = i; j < Math.min(records, i + 200); j++) {
        const k = Buffer.alloc(16);
        k.writeUInt32BE(j);
        batch.push({ key: k, data: Buffer.from(data) });
      }
      a.send(encodePush(i, batch));
      await a.until((m) => m.op === 'ack', 10_000);
    }
    return a;
  }

  test('Nachholen wartet auf den Client und trennt, wenn er nicht liest', async () => {
    const { server, port } = await start({
      messagesPerSecond: 1000,
      uploadBytesPerIpPerMinute: 0,
      sendStallTimeoutMs: 300,
    });
    try {
      const vault = randomBytes(16);
      const a = await fill(port, vault, 2000); // ≈ 32 MB
      await deafClient(port, vault);
      await waitFor(() => server.connectionCount === 2);
      await waitFor(() => server.connectionCount === 1);
      // Der Vault ist danach nicht blockiert:
      a.send(encodePush(9, [rec(1, 'neu')]));
      await a.until((m) => m.op === 'ack');
    } finally {
      await server.close();
    }
  });

  test('langsame Empfänger von Live-Änderungen werden getrennt', async () => {
    const { server, port } = await start({
      messagesPerSecond: 1000,
      uploadBytesPerIpPerMinute: 0,
      maxSendBufferBytes: 1024 * 1024,
    });
    try {
      const vault = randomBytes(16);
      const a = await Client.connect(port);
      await a.hello(vault);
      await deafClient(port, vault);
      await waitFor(() => server.connectionCount === 2);
      await new Promise((r) => setTimeout(r, 100)); // SYNCED zugestellt → live
      const data = 'x'.repeat(16 * 1024);
      for (let i = 0; i < 4000 && server.connectionCount === 2; i += 200) {
        const batch = [];
        for (let j = i; j < i + 200; j++) {
          const k = Buffer.alloc(16);
          k.writeUInt32BE(j);
          batch.push({ key: k, data: Buffer.from(data) });
        }
        a.send(encodePush(i, batch));
        await a.until((m) => m.op === 'ack', 10_000);
      }
      await waitFor(() => server.connectionCount === 1);
    } finally {
      await server.close();
    }
  });

  test('Nachholen blockiert andere Geräte nicht und liefert jede Änderung genau einmal', async () => {
    const { server, port } = await start({
      messagesPerSecond: 1000,
      uploadBytesPerIpPerMinute: 0,
      sendStallTimeoutMs: 20_000,
    });
    try {
      const vault = randomBytes(16);
      const a = await fill(port, vault, 2000); // ≈ 32 MB, passt nicht in die Socket-Puffer

      // Gerät, das nachholt, aber vorerst nichts liest.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
      await new Promise((res, rej) => ws.once('open', res).once('error', rej));
      const got: ServerMsg[] = [];
      ws.on('message', (d) => got.push(decode(d as Buffer)));
      const socket = (ws as unknown as { _socket: Socket })._socket;
      ws.send(encodeHello(vault, 0));
      socket.pause();
      await new Promise((r) => setTimeout(r, 200));

      // Währenddessen werden Änderungen des anderen Geräts sofort bestätigt.
      for (let i = 0; i < 3; i++) {
        const k = Buffer.alloc(16);
        k.writeUInt32BE(100_000 + i);
        const started = Date.now();
        a.send(encodePush(100 + i, [{ key: k, data: Buffer.from(`neu${i}`) }]));
        assert.deepEqual(await a.until((m) => m.op === 'ack', 2000), [{ op: 'ack', reqId: 100 + i, first: 2001 + i }]);
        assert.ok(Date.now() - started < 1000);
      }
      assert.ok(!got.some((m) => m.op === 'synced'));

      socket.resume();
      await waitFor(() => got.some((m) => m.op === 'synced'), 10_000);
      // Eine Änderung nach SYNCED kommt live.
      const k = Buffer.alloc(16);
      k.writeUInt32BE(200_000);
      a.send(encodePush(200, [{ key: k, data: Buffer.from('live') }]));
      await a.until((m) => m.op === 'ack');
      await waitFor(() => got.filter((m) => m.op === 'changes').some((m) => m.records.some((r) => r.seq === 2004)));

      const seqs = got.flatMap((m) => (m.op === 'changes' ? m.records.map((r) => r.seq) : []));
      assert.deepEqual(seqs, Array.from({ length: 2004 }, (_, i) => i + 1));
      const syncedAt = got.findIndex((m) => m.op === 'synced');
      assert.deepEqual(got[syncedAt], { op: 'synced', head: 2003 });
      assert.equal(got.length, syncedAt + 2);
      ws.close();
    } finally {
      await server.close();
    }
  });

  test('Client-IP-Header gilt nur von vertrauenswürdigen Proxys', async () => {
    const { server, port } = await start({
      maxConnectionsPerIp: 1,
      clientIpHeader: 'x-forwarded-for',
      trustedProxies: ['10.0.0.0/8'],
    });
    try {
      // 127.0.0.1 ist hier kein Proxy: Der Header wird ignoriert, beide zählen als 127.0.0.1.
      await Client.connect(port, { 'x-forwarded-for': '203.0.113.5' });
      await assert.rejects(Client.connect(port, { 'x-forwarded-for': '203.0.113.6' }), /429/);
      assert.deepEqual(server.drops.take(), { ipLimit: 1 });
    } finally {
      await server.close();
    }
  });

  test('abgelehnte Upgrades: Abbruch durch den Client und halboffene Sockets', { timeout: 10_000 }, async () => {
    const { server, port } = await start({});
    const http = (server as unknown as { http: import('node:http').Server }).http;
    const connections = () => new Promise<number>((res, rej) => http.getConnections((e, n) => (e ? rej(e) : res(n))));
    const request = 'GET /falsch HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
    let halfOpen: Socket | undefined;
    try {
      // Client setzt die Verbindung zurück, sobald die Ablehnung da ist → ECONNRESET beim Server.
      for (let i = 0; i < 10; i++) {
        const s = netConnect(port, '127.0.0.1');
        s.on('error', () => {});
        s.write(request);
        await new Promise((r) => s.once('data', r));
        s.resetAndDestroy();
      }
      // Halboffener Client, der nie schließt: Der Server muss den Socket trotzdem schließen.
      const s = (halfOpen = netConnect({ port, host: '127.0.0.1', allowHalfOpen: true }));
      s.on('error', () => {});
      s.write(request);
      const response = await new Promise<Buffer>((r) => s.once('data', r));
      assert.match(response.toString(), /^HTTP\/1.1 404/);
      await waitFor(async () => (await connections()) === 0);
      // Der Server läuft weiter.
      const c = await Client.connect(port);
      c.close();
      assert.equal(server.drops.take()['notFound'], 11);
    } finally {
      halfOpen?.destroy();
      await server.close();
    }
  });

  test('/health fragt die Datenbank höchstens alle 2 s', async () => {
    const store = new MemoryStore();
    let pings = 0;
    store.ping = async () => {
      pings++;
      await new Promise((r) => setTimeout(r, 50));
    };
    const server = new SyncServer(loadConfig({}), store);
    const port = await server.listen(0, '127.0.0.1');
    try {
      const res = await Promise.all(Array.from({ length: 5 }, () => fetch(`http://127.0.0.1:${port}/health`)));
      assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200]);
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      assert.equal(pings, 1);
    } finally {
      await server.close();
    }
  });

  test('Kontingent über alle Vaults', async () => {
    const { server, port } = await start({ messagesPerSecond: 1000, maxTotalBytes: 10 });
    try {
      const a = await Client.connect(port);
      await a.hello(randomBytes(16));
      a.send(encodePush(1, [rec(1, 'aaaaaa')]));
      await a.until((m) => m.op === 'ack');
      const b = await Client.connect(port);
      await b.hello(randomBytes(16));
      b.send(encodePush(1, [rec(1, 'bbbbbb')]));
      const [err] = await b.until((m) => m.op === 'error');
      assert.equal(err?.op === 'error' && err.code, 7);
      assert.match(err?.op === 'error' ? err.message : '', /Servers/);
    } finally {
      await server.close();
    }
  });

  test('unbenutzte Vaults und Tombstones laufen ab', async () => {
    const store = new MemoryStore();
    const server = new SyncServer({ ...loadConfig({}), messagesPerSecond: 1000, vaultTtlDays: 0 }, store);
    const port = await server.listen(0, '127.0.0.1');
    try {
      const used = randomBytes(16);
      const gone = randomBytes(16);
      const a = await Client.connect(port);
      await a.hello(used);
      a.send(encodePush(1, [rec(1, 'eins')]));
      await a.until((m) => m.op === 'ack');
      const b = await Client.connect(port);
      await b.hello(gone);
      b.send(encodePush(1, [rec(1, 'x')]));
      await b.until((m) => m.op === 'ack');
      b.send(Buffer.from([Op.deleteVault]));
      await b.until((m) => m.op === 'deleted');

      assert.equal(await store.expire(new Date(Date.now() - 60_000)), 0);
      assert.equal(await store.expire(new Date(Date.now() + 60_000)), 2);

      // Ein zurückkehrendes Gerät sieht einen leeren Vault und lädt neu hoch.
      const c = await Client.connect(port);
      assert.deepEqual(await c.hello(used, 1), [{ op: 'synced', head: 0 }]);
      // Der Tombstone ist weg, der Code wieder verwendbar.
      const d = await Client.connect(port);
      assert.deepEqual(await d.hello(gone, 0), [{ op: 'synced', head: 0 }]);
    } finally {
      await server.close();
    }
  });

  test('Ablauf überspringt Vaults mit verbundenen Geräten', async () => {
    const { server, port } = await start({ messagesPerSecond: 1000, vaultTtlDays: 0 });
    try {
      const kept = randomBytes(16);
      const gone = randomBytes(16);
      const a = await Client.connect(port);
      await a.hello(kept);
      a.send(encodePush(1, [rec(1, 'eins')]));
      await a.until((m) => m.op === 'ack');
      const keptEpoch = a.epoch;
      const b = await Client.connect(port);
      await b.hello(gone);
      b.send(encodePush(1, [rec(1, 'x')]));
      await b.until((m) => m.op === 'ack');
      const goneEpoch = b.epoch;
      b.close();
      await b.until(() => false, 200).catch(() => {});

      await new Promise((r) => setTimeout(r, 10));
      await server.expireVaults(); // TTL 0: alles ohne Verbindung läuft ab
      a.send(encodePush(2, [rec(2, 'zwei')]));
      assert.deepEqual(await a.until((m) => m.op === 'ack'), [{ op: 'ack', reqId: 2, first: 2 }]);
      const c = await Client.connect(port);
      assert.deepEqual(await c.hello(kept, 2), [{ op: 'synced', head: 2 }]);
      assert.equal(c.epoch, keptEpoch);
      const d = await Client.connect(port);
      assert.deepEqual(await d.hello(gone, 1), [{ op: 'synced', head: 0 }]);
      assert.notEqual(d.epoch, goneEpoch);
    } finally {
      await server.close();
    }
  });

  test('MAX_CONNECTIONS zählt Upgrades selbst und gibt sie wieder frei', async () => {
    const { server, port } = await start({ maxConnections: 1 });
    try {
      // Fehlgeschlagenes Upgrade (ohne Sec-WebSocket-Key) belegt danach keinen Platz.
      const s = netConnect(port, '127.0.0.1');
      s.on('error', () => {});
      s.write('GET /sync HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      const response = await new Promise<Buffer>((r) => s.once('data', r));
      assert.match(response.toString(), /^HTTP\/1.1 400/);
      await new Promise((r) => s.once('close', r));

      const a = await Client.connect(port);
      await assert.rejects(Client.connect(port), /503/);
      a.close();
      await a.until(() => false, 200).catch(() => {});
      (await Client.connect(port)).close();
      assert.equal(server.drops.take()['serverFull'], 1);
    } finally {
      await server.close();
    }
  });

  test('MESSAGES_PER_SECOND=0 heißt unbegrenzt', async () => {
    const { server, port } = await start({ messagesPerSecond: 0 });
    try {
      const a = await Client.connect(port);
      for (let i = 0; i < 50; i++) a.send(Buffer.from([Op.ping]));
      let pongs = 0;
      await a.until((m) => m.op === 'pong' && ++pongs === 50);
      assert.equal(loadConfig({ MESSAGES_PER_SECOND: '0' }).messagesPerSecond, 0);
    } finally {
      await server.close();
    }
  });

  /** Server, dessen Speicher PUSHes erst nach `release()` ausführt. */
  async function stalledServer() {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const put = store.put.bind(store);
    store.put = async (...args) => {
      await gate;
      return put(...args);
    };
    const server = new SyncServer(
      { ...loadConfig({}), messagesPerSecond: 1000, uploadBytesPerIpPerMinute: 0 },
      store,
    );
    return { server, port: await server.listen(0, '127.0.0.1'), release };
  }

  test('zu viele unbestätigte PUSHes pro Verbindung', async () => {
    const { server, port, release } = await stalledServer();
    try {
      const a = await Client.connect(port);
      await a.hello(randomBytes(16));
      for (let i = 0; i <= MAX_QUEUED_PUSHES; i++) a.send(encodePush(i, [rec(i, 'x')]));
      const msgs = await a.until((m) => m.op === 'error');
      assert.deepEqual(msgs, [{ op: 'error', code: 4, message: 'Zu viele unbestätigte Änderungen' }]);
      // Eine andere Verbindung desselben Servers ist davon nicht betroffen.
      const b = await Client.connect(port);
      await b.hello(randomBytes(16));
      b.send(encodePush(1, [rec(1, 'x')]));
      release();
      await b.until((m) => m.op === 'ack');
    } finally {
      release();
      await server.close();
    }
  });

  test('zu viele unbestätigte Bytes pro Verbindung', async () => {
    const { server, port, release } = await stalledServer();
    try {
      const a = await Client.connect(port);
      await a.hello(randomBytes(16));
      const data = Buffer.from('x'.repeat(16 * 1024));
      const push = (n: number) => {
        const batch = [];
        for (let j = 0; j < 200; j++) {
          const k = Buffer.alloc(16);
          k.writeUInt32BE(n * 1000 + j);
          batch.push({ key: k, data });
        }
        return encodePush(n, batch);
      };
      const perPush = 200 * (16 + data.length);
      const fit = Math.floor(MAX_QUEUED_PUSH_BYTES / perPush);
      assert.ok(fit < MAX_QUEUED_PUSHES);
      for (let i = 0; i <= fit; i++) a.send(push(i));
      const [err] = await a.until((m) => m.op === 'error', 10_000);
      assert.equal(err?.op === 'error' && err.code, 4);
    } finally {
      release();
      await server.close();
    }
  });

  test('gleichzeitige PUSHes in verschiedene Vaults überschreiten das Gesamt-Kontingent nicht', async () => {
    const { server, port } = await start({ messagesPerSecond: 1000, maxTotalBytes: 10 });
    try {
      const clients = await Promise.all([0, 1, 2].map(() => Client.connect(port)));
      for (const c of clients) await c.hello(randomBytes(16));
      clients.forEach((c, i) => c.send(encodePush(1, [rec(i, 'xxxxxx')])));
      const results = await Promise.all(clients.map((c) => c.until((m) => m.op === 'ack' || m.op === 'error')));
      assert.deepEqual(results.map((r) => r.at(-1)!.op).sort(), ['ack', 'error', 'error']);
    } finally {
      await server.close();
    }
  });

  test('ohne HELLO wird getrennt', async () => {
    const { server, port } = await start({ helloTimeoutMs: 100 });
    try {
      const a = await Client.connect(port);
      await assert.rejects(a.until(() => false, 2000), /geschlossen/);
      assert.deepEqual(server.drops.take(), { helloTimeout: 1 });
    } finally {
      await server.close();
    }
  });
});

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
