import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/store.ts';
import { SyncServer } from '../src/sync-server.ts';
import { Updates, compareVersions, parseUpdateFile } from '../src/updates.ts';
import type { UpdateManifest } from '../src/updates.ts';

const APK = Buffer.from('apk-1.10.0'.repeat(1000));

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'antatime-updates-'));
  await mkdir(join(dir, 'updates', 'antatime-9.9.9.apk'), { recursive: true }); // Verzeichnis, keine Datei
  await writeFile(join(dir, 'updates', 'antatime-1.9.3.apk'), 'alt');
  await writeFile(join(dir, 'updates', 'antatime-1.10.0.apk'), APK);
  await writeFile(join(dir, 'updates', 'AnTaTime-1.10.0-x86_64.AppImage'), 'appimage');
  await writeFile(join(dir, 'updates', 'antatime_1.10.0_amd64.deb'), 'deb');
  await writeFile(join(dir, 'updates', 'antatime_1.10.0_arm64.deb'), 'deb-arm');
  await writeFile(join(dir, 'updates', 'antatime-1.10.0-linux-x64.tar.gz'), 'tar');
  await writeFile(join(dir, 'updates', 'notizen.txt'), 'privat');
  await writeFile(join(dir, 'geheim.apk'), 'geheim');
});
after(() => rm(dir, { recursive: true, force: true }));

async function withServer(fn: (base: string) => Promise<void>) {
  const updates = new Updates(join(dir, 'updates'));
  const server = new SyncServer(loadConfig({}), new MemoryStore(), null, updates);
  const port = await server.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

test('Dateinamen und Versionen', () => {
  assert.deepEqual(parseUpdateFile('antatime-1.5.1.apk'), {
    platform: 'android',
    kind: 'apk',
    arch: null,
    version: '1.5.1',
  });
  assert.deepEqual(parseUpdateFile('AnTaTime-1.5.1-aarch64.AppImage'), {
    platform: 'linux',
    kind: 'appimage',
    arch: 'arm64',
    version: '1.5.1',
  });
  assert.equal(parseUpdateFile('antatime_1.5.1_amd64.deb')?.arch, 'x64');
  assert.equal(parseUpdateFile('antatime-1.5.1-linux-x64.tar.gz')?.kind, 'tar');
  assert.deepEqual(parseUpdateFile('AnTaTime-1.5.1-windows-x64-setup.exe'), {
    platform: 'windows',
    kind: 'exe',
    arch: 'x64',
    version: '1.5.1',
  });
  assert.equal(parseUpdateFile('antatime-1.5.1-windows-x64.zip')?.kind, 'zip');
  assert.deepEqual(parseUpdateFile('AnTaTime-1.5.1-macos.dmg'), {
    platform: 'macos',
    kind: 'dmg',
    arch: null,
    version: '1.5.1',
  });
  assert.equal(parseUpdateFile('AnTaTime-1.5.1-macos.zip'), null);
  assert.equal(parseUpdateFile('antatime-web-1.5.1.zip'), null);
  assert.equal(parseUpdateFile('../antatime-1.5.1.apk'), null);
  assert.equal(parseUpdateFile('antatime-1.5.1.apk.part'), null);
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.5', '1.5.1') < 0);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
});

test('latest.json nennt je Paketart die höchste Version', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/updates/latest.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { packages } = (await res.json()) as UpdateManifest;
    assert.deepEqual(
      packages.map((p) => p.file),
      [
        'AnTaTime-1.10.0-x86_64.AppImage',
        'antatime-1.10.0-linux-x64.tar.gz',
        'antatime-1.10.0.apk',
        'antatime_1.10.0_amd64.deb',
        'antatime_1.10.0_arm64.deb',
      ],
    );
    const apk = packages.find((p) => p.kind === 'apk')!;
    assert.deepEqual(apk, {
      platform: 'android',
      kind: 'apk',
      arch: null,
      version: '1.10.0',
      file: 'antatime-1.10.0.apk',
      size: APK.length,
      sha256: createHash('sha256').update(APK).digest('hex'),
    });
  });
});

test('Pakete werden ausgeliefert, alles andere nicht', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/updates/antatime-1.10.0.apk`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(res.headers.get('content-length'), String(APK.length));
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="antatime-1.10.0.apk"',
    );
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), APK);

    const head = await fetch(`${base}/updates/antatime-1.10.0.apk`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(APK.length));

    assert.equal((await fetch(`${base}/updates/antatime-1.9.3.apk`)).status, 200); // alte bleiben abrufbar
    assert.equal((await fetch(`${base}/updates/notizen.txt`)).status, 404);
    assert.equal((await fetch(`${base}/updates/antatime-2.0.0.apk`)).status, 404);
    assert.equal((await fetch(`${base}/updates/antatime-9.9.9.apk`)).status, 404);
    assert.equal((await fetch(`${base}/updates/%2e%2e%2fgeheim.apk`)).status, 404);
    assert.equal((await fetch(`${base}/updates/latest.json`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('ohne UPDATES_DIR gibt es /updates nicht', async () => {
  const server = new SyncServer(loadConfig({}), new MemoryStore(), null);
  const port = await server.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/updates/latest.json`)).status, 404);
  } finally {
    await server.close();
  }
});
