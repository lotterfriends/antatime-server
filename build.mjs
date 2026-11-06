// Bündelt den Server mit allen Abhängigkeiten – und, falls vorhanden, dem
// Flutter-Web-Build der App – in eine ausführbare Datei:
//
//   dist/antatime-server.cjs  →  node dist/antatime-server.cjs
//
// Web-Build: WEB_BUILD=/pfad/zu/build/web (Standard ../antatime-app/build/web),
// WEB_BUILD=off bündelt ohne Web-App.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import { build } from 'esbuild';

const outfile = 'dist/antatime-server.cjs';
const webBuild = process.env.WEB_BUILD ?? '../antatime-app/build/web';

// Gleiche Regeln wie src/web-app.ts (dort zur Laufzeit für WEB_DIR).
const INCOMPRESSIBLE = new Set(['.png', '.jpg', '.woff2', '.ico']);
const isServedFile = (p) => !p.endsWith('.symbols') && !p.endsWith('.last_build_id');
const META = '<meta name="antatime-sync-url" content="same-origin">';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

const compress = promisify(brotliCompress);

/** Liest den Web-Build und komprimiert ihn mit Brotli (höchste Stufe). */
async function embedWeb() {
  if (webBuild === 'off') return null;
  if (!existsSync(join(webBuild, 'index.html'))) {
    console.warn(`⚠ Kein Web-Build unter ${webBuild} – Server ohne eingebettete Web-App.`);
    console.warn('  Erst `flutter build web` in antatime-app ausführen oder WEB_BUILD setzen.');
    return null;
  }
  const started = Date.now();
  const tasks = [];
  for await (const file of walk(webBuild)) {
    const path = relative(webBuild, file).split(sep).join('/');
    if (!isServedFile(path)) continue;
    tasks.push(
      (async () => {
        let raw = await readFile(file);
        if (path === 'index.html') {
          raw = Buffer.from(raw.toString('utf8').replace(/<head>/i, (m) => `${m}\n  ${META}`));
        }
        const etag = `"${createHash('sha256').update(raw).digest('base64url').slice(0, 22)}"`;
        if (INCOMPRESSIBLE.has(extname(path).toLowerCase())) {
          return { path, etag, data: raw, compressed: 0, raw: raw.length };
        }
        const br = await compress(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        });
        return { path, etag, data: br, compressed: 1, raw: raw.length };
      })(),
    );
  }
  const files = (await Promise.all(tasks)).sort((a, b) => a.path.localeCompare(b.path));
  const raw = files.reduce((n, f) => n + f.raw, 0);
  const packed = files.reduce((n, f) => n + f.data.length, 0);
  console.log(
    `Web-App eingebettet: ${files.length} Dateien, ${mb(raw)} → ${mb(packed)} ` +
      `(Brotli, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  return files;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const web = await embedWeb();

/** Ersetzt src/web-embedded.ts durch die eingebetteten Dateien. */
const embedPlugin = {
  name: 'web-embedded',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]web-embedded\.ts$/ }, () => ({
      loader: 'js',
      contents: web
        ? 'export default ' +
          JSON.stringify(web.map((f) => [f.path, f.etag, f.data.toString('base64'), f.compressed]))
        : 'export default null',
    }));
  },
};

await build({
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  // Optionale native Beschleuniger von `ws`; ohne sie läuft alles in JS.
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [embedPlugin],
  logLevel: 'info',
});
await chmod(outfile, 0o755);
