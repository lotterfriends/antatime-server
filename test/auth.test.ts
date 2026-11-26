import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { ServerAuth, answerChallenge, decodeKey, encodeKey, generateServerKey } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { Database } from '../src/db.ts';
import { ErrorCode, Op, encodeAuth, encodeHello, encodePush } from '../src/protocol.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import { SyncServer, vaultHash } from '../src/sync-server.ts';

/** Test-Client, der die rohen Nachrichten sammelt. */
class Raw {
  readonly frames: Buffer[] = [];
  private waiters: (() => void)[] = [];
  private readonly ws: WebSocket;
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => {
      this.frames.push(d as Buffer);
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

  static async connect(port: number): Promise<Raw> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    const raw = new Raw(ws);
    await new Promise((res, rej) => ws.once('open', res).once('error', rej));
    return raw;
  }

  send(buf: Buffer) {
    this.ws.send(buf);
  }

  /** Nächste Nachricht mit Opcode [op]; frühere werden verworfen. */
  async next(op: number, timeoutMs = 3000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.frames.findIndex((f) => f[0] === op);
      if (i >= 0) return this.frames.splice(0, i + 1).pop()!;
      if (this.closed) throw new Error('Verbindung geschlossen');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Zeitüberschreitung, erhalten: ${this.frames.map((f) => f[0])}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, left);
      });
    }
  }

  async error(): Promise<{ code: number; message: string }> {
    const f = await this.next(Op.error);
    return { code: f[1]!, message: f.subarray(2).toString() };
  }

  async closedSoon(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('Verbindung blieb offen');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Meldet sich mit [serverKey] an; liefert, ob der Nachweis des Servers stimmt. */
  async login(serverKey: string): Promise<boolean> {
    const nonce = (await this.next(Op.challenge)).subarray(1);
    const answer = answerChallenge(serverKey, nonce);
    this.send(encodeAuth(answer.ephPub, answer.mac));
    const ok = await this.next(Op.authOk);
    return ok.subarray(1).equals(answer.proof);
  }

  close() {
    this.ws.close();
  }
}

const rec = (n: number, data = 'x') => ({ key: Buffer.alloc(16, n), data: Buffer.from(data) });

test('Schlüssel als Text: lesbar, tolerant, eindeutig', () => {
  const raw = randomBytes(32);
  const text = encodeKey(raw);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(decodeKey(text), raw);
  assert.deepEqual(decodeKey(` ${text.toLowerCase().replaceAll('-', ' ')} `), raw);
  assert.deepEqual(decodeKey('O'.repeat(52)), Buffer.alloc(32));
  assert.equal(decodeKey(text.slice(1)), null);
  assert.equal(decodeKey('U'.repeat(52)), null);
  // Die letzten 4 Bit müssen 0 sein.
  assert.equal(decodeKey('0'.repeat(51) + '1'), null);
  assert.deepEqual(decodeKey(encodeKey(Buffer.alloc(32, 0xff))), Buffer.alloc(32, 0xff));
});

test('Anmeldung: nur mit dem passenden Server-Schlüssel, Server weist sich aus', () => {
  const key = generateServerKey();
  const auth = new ServerAuth(key.privateKey);
  assert.equal(auth.publicKey, key.publicKey);
  const nonce = auth.challenge();
  const good = answerChallenge(key.publicKey, nonce);
  assert.deepEqual(auth.verify(nonce, good.ephPub, good.mac), good.proof);
  // Antwort gilt nur für diese CHALLENGE.
  assert.equal(auth.verify(auth.challenge(), good.ephPub, good.mac), null);
  const other = answerChallenge(generateServerKey().publicKey, nonce);
  assert.equal(auth.verify(nonce, other.ephPub, other.mac), null);
  // Ungültige Punkte (alles 0) und falsche Längen werden abgelehnt, nicht geworfen.
  assert.equal(auth.verify(nonce, Buffer.alloc(32), good.mac), null);
  assert.equal(auth.verify(nonce, good.ephPub, good.mac.subarray(1)), null);
  assert.throws(() => new ServerAuth('kein Schlüssel'), /SERVER_PRIVATE_KEY/);
});

test('Konfiguration: SERVER_PRIVATE_KEY und MAX_VAULTS sind optional', () => {
  const c = loadConfig({});
  assert.equal(c.serverPrivateKey, '');
  assert.equal(c.maxVaults, 0);
  const d = loadConfig({ SERVER_PRIVATE_KEY: ' abc ', MAX_VAULTS: '3' });
  assert.equal(d.serverPrivateKey, 'abc');
  assert.equal(d.maxVaults, 3);
  assert.throws(() => new SyncServer({ ...c, serverPrivateKey: 'abc' }, new MemoryStore()), /SERVER_PRIVATE_KEY/);
});

describe('Server mit SERVER_PRIVATE_KEY', () => {
  const key = generateServerKey();
  let server: SyncServer;
  let port: number;

  before(async () => {
    server = new SyncServer({ ...loadConfig({}), serverPrivateKey: key.privateKey }, new MemoryStore());
    port = await server.listen(0, '127.0.0.1');
  });
  after(() => server.close());

  test('mit Schlüssel: anmelden, dann normal synchronisieren', async () => {
    const vault = randomBytes(16);
    const b = await Raw.connect(port);
    assert.equal(await b.login(key.publicKey), true);
    b.send(encodeHello(vault, 0));
    await b.next(Op.synced);
    b.send(encodePush(1, [rec(1)]));
    await b.next(Op.ack);
    b.close();
  });

  test('ohne Anmeldung: HELLO wird mit authRequired abgewiesen, PING geht', async () => {
    const a = await Raw.connect(port);
    a.send(Buffer.from([Op.ping]));
    await a.next(Op.pong);
    a.send(encodeHello(randomBytes(16), 0));
    const err = await a.error();
    assert.equal(err.code, ErrorCode.authRequired);
    assert.match(err.message, /Server-Schlüssel/);
    await a.closedSoon();
  });

  test('falscher Schlüssel: authFailed und getrennt', async () => {
    const a = await Raw.connect(port);
    const nonce = (await a.next(Op.challenge)).subarray(1);
    const wrong = answerChallenge(generateServerKey().publicKey, nonce);
    a.send(encodeAuth(wrong.ephPub, wrong.mac));
    assert.equal((await a.error()).code, ErrorCode.authFailed);
    await a.closedSoon();
  });

  test('jede Verbindung bekommt eine eigene CHALLENGE, AUTH nur einmal', async () => {
    const a = await Raw.connect(port);
    const b = await Raw.connect(port);
    const na = (await a.next(Op.challenge)).subarray(1);
    const nb = (await b.next(Op.challenge)).subarray(1);
    assert.notDeepEqual(na, nb);
    // Eine mitgeschnittene Antwort hilft auf einer anderen Verbindung nicht.
    const answer = answerChallenge(key.publicKey, na);
    b.send(encodeAuth(answer.ephPub, answer.mac));
    assert.equal((await b.error()).code, ErrorCode.authFailed);
    a.send(encodeAuth(answer.ephPub, answer.mac));
    await a.next(Op.authOk);
    a.send(encodeAuth(answer.ephPub, answer.mac));
    assert.equal((await a.error()).code, ErrorCode.badRequest);
  });
});

test('Server ohne Schlüssel: keine CHALLENGE, AUTH ist ein Fehler', async () => {
  const server = new SyncServer(loadConfig({}), new MemoryStore());
  const port = await server.listen(0, '127.0.0.1');
  try {
    assert.equal(server.auth, null);
    const a = await Raw.connect(port);
    a.send(Buffer.from([Op.ping]));
    await a.next(Op.pong);
    assert.equal(a.frames.length, 0);
    a.send(encodeAuth(randomBytes(32), randomBytes(32)));
    assert.equal((await a.error()).code, ErrorCode.badRequest);
  } finally {
    await server.close();
  }
});

function maxVaultsSuite(name: string, makeStore: () => Promise<Store>) {
  describe(name, () => {
    let store: Store;
    let server: SyncServer;
    let port: number;
    let base: number;

    /** Server, der über den jetzigen Bestand hinaus noch [extra] Vaults annimmt. */
    async function limited(extra: number) {
      base = await store.vaultCount();
      server = new SyncServer({ ...loadConfig({}), messagesPerSecond: 1000, maxVaults: base + extra }, store);
      port = await server.listen(0, '127.0.0.1');
    }

    async function join(vault: Buffer): Promise<Raw> {
      const c = await Raw.connect(port);
      c.send(encodeHello(vault, 0));
      return c;
    }

    before(async () => {
      store = await makeStore();
    });
    after(() => store.close());

    test('voller Server weist neue Vaults ab, bestehende laufen weiter', async () => {
      await limited(2);
      try {
        const v1 = randomBytes(16);
        const v2 = randomBytes(16);
        const a = await join(v1);
        await a.next(Op.synced);
        a.send(encodePush(1, [rec(1)]));
        await a.next(Op.ack);
        // Verbunden, aber leer: belegt noch keinen Platz.
        const idle = await join(randomBytes(16));
        await idle.next(Op.synced);
        const b = await join(v2);
        await b.next(Op.synced);
        b.send(encodePush(1, [rec(1)]));
        await b.next(Op.ack);
        assert.equal(await store.vaultCount(), base + 2);

        // Voll: Ein neuer Code wird schon beim HELLO abgewiesen …
        const c = await join(randomBytes(16));
        const err = await c.error();
        assert.equal(err.code, ErrorCode.serverFull);
        assert.match(err.message, /maximale Anzahl an Nutzern/);
        await c.closedSoon();
        // … und wer vorher verbunden war, beim ersten PUSH.
        idle.send(encodePush(1, [rec(1)]));
        assert.equal((await idle.error()).code, ErrorCode.serverFull);

        // Bestehende Nutzer merken nichts, auch weitere Geräte nicht.
        a.send(encodePush(2, [rec(2)]));
        await a.next(Op.ack);
        const a2 = await join(v1);
        await a2.next(Op.synced);

        // Löscht ein Nutzer seine Daten, wird der Platz frei.
        b.send(Buffer.from([Op.deleteVault]));
        await b.next(Op.vaultDeleted);
        assert.equal(await store.vaultCount(), base + 1);
        const d = await join(randomBytes(16));
        await d.next(Op.synced);
        d.send(encodePush(1, [rec(1)]));
        await d.next(Op.ack);
        for (const x of [a, a2, d]) x.close();
      } finally {
        await server.close();
      }
    });

    test('gleichzeitige erste PUSHes überschreiten das Limit nicht', async () => {
      await limited(1);
      try {
        const clients = await Promise.all(Array.from({ length: 6 }, () => join(randomBytes(16))));
        await Promise.all(clients.map((c) => c.next(Op.synced)));
        for (const c of clients) c.send(encodePush(1, [rec(1)]));
        const results = await Promise.all(
          clients.map((c) =>
            Promise.race([c.next(Op.ack).then(() => 'ack'), c.error().then((e) => `error ${e.code}`)]),
          ),
        );
        assert.equal(results.filter((r) => r === 'ack').length, 1, results.join(', '));
        assert.equal(results.filter((r) => r === `error ${ErrorCode.serverFull}`).length, 5);
        assert.equal(await store.vaultCount(), base + 1);
      } finally {
        await server.close();
      }
    });

    test('abgewiesene Vaults werden nicht angelegt', async () => {
      await limited(0);
      try {
        const vault = randomBytes(16);
        const c = await join(vault);
        assert.equal((await c.error()).code, ErrorCode.serverFull);
        assert.equal((await store.head(vaultHash(vault))).epoch, 0);
      } finally {
        await server.close();
      }
    });
  });
}

maxVaultsSuite('MAX_VAULTS (Arbeitsspeicher)', async () => new MemoryStore());

const dbUrl = process.env['TEST_DATABASE_URL'];
if (dbUrl) {
  maxVaultsSuite('MAX_VAULTS (MySQL)', async () => {
    const db = new Database(loadConfig({ DATABASE_URL: dbUrl }).db);
    await db.init();
    return db;
  });
}
