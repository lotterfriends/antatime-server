import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from 'node:zlib';

/**
 * Auslieferung der AnTaTime-Web-App (Flutter-Web-Build).
 *
 * Zwei Quellen:
 *  * eingebettet: `npm run build` packt den Web-Build Brotli-komprimiert in
 *    das Server-Bundle (siehe build.mjs) – eine Datei für alles,
 *  * Verzeichnis: `WEB_DIR=/pfad/zu/build/web` (z. B. für die Entwicklung oder
 *    um die App ohne neuen Server-Build zu aktualisieren).
 *
 * Komprimiert wird nach Wunsch des Browsers (Brotli, gzip, sonst roh), jede
 * Variante nur einmal und dann im Speicher gehalten. Flutter-Dateien tragen
 * keinen Inhalts-Hash im Namen, daher `no-cache` + ETag: Der Browser fragt
 * jedes Mal nach und bekommt ein kurzes 304, solange sich nichts geändert hat.
 */

const MIME: { [ext: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '': 'text/plain; charset=utf-8', // z. B. assets/NOTICES
};

const INCOMPRESSIBLE = new Set(['.png', '.jpg', '.woff2', '.ico']);

/** Dateien des Flutter-Builds, die nicht ausgeliefert werden. */
export function isServedFile(path: string): boolean {
  return !path.endsWith('.symbols') && !path.endsWith('.last_build_id');
}

/**
 * Markiert die Web-App als „von einem AnTaTime-Server ausgeliefert“. Die App
 * schlägt dann diesen Server für die Synchronisation vor.
 */
export function injectSyncMeta(html: Buffer): Buffer {
  const meta = '<meta name="antatime-sync-url" content="same-origin">';
  const s = html.toString('utf8');
  if (s.includes('antatime-sync-url')) return html;
  return Buffer.from(s.replace(/<head>/i, (m) => `${m}\n  ${meta}`), 'utf8');
}

export function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function isCompressible(path: string): boolean {
  return !INCOMPRESSIBLE.has(extname(path).toLowerCase());
}

export function etagOf(raw: Buffer): string {
  return `"${createHash('sha256').update(raw).digest('base64url').slice(0, 22)}"`;
}

export class Asset {
  readonly type: string;
  readonly etag: string;
  readonly compressible: boolean;
  private raw: Buffer | undefined;
  private br: Buffer | undefined;
  private gz: Buffer | undefined;

  constructor(
    path: string,
    init: { raw?: Buffer; br?: Buffer; etag: string },
  ) {
    this.type = contentType(path);
    this.compressible = isCompressible(path);
    this.etag = init.etag;
    this.raw = init.raw;
    this.br = init.br;
  }

  identity(): Buffer {
    return (this.raw ??= brotliDecompressSync(this.br!));
  }

  brotli(): Buffer {
    return (this.br ??= brotliCompressSync(this.identity(), {
      params: {
        // Schnell genug für die Erzeugung zur Laufzeit (nur Verzeichnis-Modus).
        [constants.BROTLI_PARAM_QUALITY]: 6,
        [constants.BROTLI_PARAM_SIZE_HINT]: this.identity().length,
      },
    }));
  }

  gzip(): Buffer {
    return (this.gz ??= gzipSync(this.identity(), { level: 9 }));
  }
}

export interface WebApp {
  /** [path] ohne führenden Schrägstrich, z. B. `main.dart.js`. */
  get(path: string): Promise<Asset | undefined>;
  readonly source: string;
}

/** Eingebetteter Build: `[pfad, etag, brotli|roh (base64), komprimiert?]`. */
export type EmbeddedFile = [string, string, string, 0 | 1];

export class EmbeddedWebApp implements WebApp {
  private readonly assets = new Map<string, Asset>();
  readonly source = 'eingebettet';

  constructor(files: EmbeddedFile[]) {
    for (const [path, etag, data, compressed] of files) {
      const bytes = Buffer.from(data, 'base64');
      this.assets.set(
        path,
        new Asset(path, compressed ? { br: bytes, etag } : { raw: bytes, etag }),
      );
    }
  }

  get size(): number {
    return this.assets.size;
  }

  async get(path: string): Promise<Asset | undefined> {
    return this.assets.get(path);
  }
}

export class DirectoryWebApp implements WebApp {
  private readonly root: string;
  private readonly cache = new Map<string, { mtime: number; size: number; asset: Asset }>();
  readonly source: string;

  constructor(dir: string) {
    this.root = resolve(dir);
    this.source = this.root;
  }

  async get(path: string): Promise<Asset | undefined> {
    if (!isServedFile(path)) return undefined;
    const file = join(this.root, path);
    if (file !== this.root && !file.startsWith(this.root + sep)) return undefined;
    let st;
    try {
      st = await stat(file);
    } catch {
      return undefined;
    }
    if (!st.isFile()) return undefined;
    const hit = this.cache.get(path);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.asset;
    let raw: Buffer = await readFile(file);
    if (path === 'index.html') raw = injectSyncMeta(raw);
    const asset = new Asset(path, { raw, etag: etagOf(raw) });
    this.cache.set(path, { mtime: st.mtimeMs, size: st.size, asset });
    return asset;
  }
}

function accepts(req: IncomingMessage, encoding: string): boolean {
  const h = req.headers['accept-encoding'];
  const v = Array.isArray(h) ? h.join(',') : (h ?? '');
  return v
    .split(',')
    .map((p) => p.trim().split(';'))
    .some(([name, q]) => name === encoding && q?.trim() !== 'q=0');
}

/** Liefert eine Datei der Web-App aus. Gibt `false` zurück, wenn es keine gibt. */
export async function serveWebApp(
  app: WebApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  if (path.includes('\0') || path.split('/').includes('..')) return false;
  path = path.replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';

  let asset = await app.get(path);
  // Ohne Dateiendung: Seite der App → index.html (falls die App eigene
  // Pfade verwendet).
  if (!asset && extname(path) === '') asset = await app.get('index.html');
  if (!asset) return false;

  const headers: { [name: string]: string } = {
    'content-type': asset.type,
    etag: asset.etag,
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let body: Buffer;
  if (asset.compressible && accepts(req, 'br')) {
    body = asset.brotli();
    headers['content-encoding'] = 'br';
  } else if (asset.compressible && accepts(req, 'gzip')) {
    body = asset.gzip();
    headers['content-encoding'] = 'gzip';
  } else {
    body = asset.identity();
  }
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
