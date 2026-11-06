import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';

import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/store.ts';
import { SyncServer } from '../src/sync-server.ts';
import { DirectoryWebApp, EmbeddedWebApp, etagOf } from '../src/web-app.ts';
import type { WebApp } from '../src/web-app.ts';

const INDEX = '<!DOCTYPE html><html><head><base href="/"></head><body></body></html>';
const JS = 'console.log("AnTaTime");'.repeat(200);

async function withServer(web: WebApp, fn: (base: string) => Promise<void>) {
  const server = new SyncServer(loadConfig({}), new MemoryStore(), web);
  const port = await server.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

/** Rohe Antwort ohne automatische Dekomprimierung. */
function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; header: (n: string) => string | null; body: Buffer }>(
    (resolve, reject) => {
      request(url, { headers: { 'accept-encoding': 'identity', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            header: (n) => (res.headers[n] as string | undefined) ?? null,
            body: Buffer.concat(chunks),
          }),
        );
      })
        .on('error', reject)
        .end();
    },
  );
}

function checkApp(name: string, makeApp: () => Promise<WebApp>) {
  describe(name, () => {
    let web: WebApp;
    before(async () => {
      web = await makeApp();
    });

    test('liefert Dateien mit Typ, Kompression und ETag', async () => {
      await withServer(web, async (base) => {
        const index = await get(`${base}/`);
        assert.equal(index.status, 200);
        assert.match(index.header('content-type')!, /text\/html/);
        assert.match(index.body.toString(), /antatime-sync-url/);

        const br = await get(`${base}/main.dart.js`, { 'accept-encoding': 'gzip, br' });
        assert.equal(br.header('content-encoding'), 'br');
        assert.equal(brotliDecompressSync(br.body).toString(), JS);
        assert.ok(br.body.length < JS.length / 10);

        const gz = await get(`${base}/main.dart.js`, { 'accept-encoding': 'gzip' });
        assert.equal(gz.header('content-encoding'), 'gzip');
        assert.equal(gunzipSync(gz.body).toString(), JS);

        const plain = await get(`${base}/main.dart.js`);
        assert.equal(plain.header('content-encoding'), null);
        assert.equal(plain.body.toString(), JS);

        const etag = plain.header('etag')!;
        const cached = await get(`${base}/main.dart.js`, { 'if-none-match': etag });
        assert.equal(cached.status, 304);
        assert.equal(cached.body.length, 0);

        const wasm = await get(`${base}/canvaskit/x.wasm`);
        assert.equal(wasm.header('content-type'), 'application/wasm');
      });
    });

    test('Seiten ohne Endung → index.html, sonst 404, kein Ausbruch', async () => {
      await withServer(web, async (base) => {
        assert.equal((await get(`${base}/verlauf`)).status, 200);
        assert.equal((await get(`${base}/fehlt.js`)).status, 404);
        assert.equal((await get(`${base}/main.dart.js.symbols`)).status, 404);
        assert.equal((await get(`${base}/%2e%2e/geheim.txt`)).status, 404);
        assert.equal((await get(`${base}/health`)).status, 200);
      });
    });
  });
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'antatime-web-'));
  await mkdir(join(dir, 'web', 'canvaskit'), { recursive: true });
  await writeFile(join(dir, 'web', 'index.html'), INDEX);
  await writeFile(join(dir, 'web', 'main.dart.js'), JS);
  await writeFile(join(dir, 'web', 'main.dart.js.symbols'), 'x');
  await writeFile(join(dir, 'web', 'canvaskit', 'x.wasm'), Buffer.from([0, 97, 115, 109]));
  await writeFile(join(dir, 'geheim.txt'), 'geheim');
});
after(() => rm(dir, { recursive: true, force: true }));

checkApp('Web-App aus Verzeichnis', async () => new DirectoryWebApp(join(dir, 'web')));

checkApp('Eingebettete Web-App', async () => {
  const index = Buffer.from(INDEX.replace('<head>', '<head><meta name="antatime-sync-url">'));
  const br = (s: string | Buffer) => brotliCompressSync(s).toString('base64');
  const wasm = Buffer.from([0, 97, 115, 109]);
  return new EmbeddedWebApp([
    ['index.html', etagOf(index), br(index), 1],
    ['main.dart.js', etagOf(Buffer.from(JS)), br(JS), 1],
    ['canvaskit/x.wasm', etagOf(wasm), br(wasm), 1],
  ]);
});
