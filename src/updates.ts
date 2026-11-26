import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Updates für Apps, die nicht aus einem Store kommen (Android-APK, Linux,
 * Windows, macOS) – als Alternative zu den GitHub-Releases, aus denen die
 * Apps sie sonst holen (App mit `UPDATE_URL` gebaut).
 *
 * `UPDATES_DIR` zeigt auf ein Verzeichnis mit den Paketen, so wie die
 * Build-Skripte der App sie in `dist/` ablegen:
 *
 *   antatime-1.6.0.apk
 *   AnTaTime-1.6.0-x86_64.AppImage
 *   antatime_1.6.0_amd64.deb
 *   antatime-1.6.0-linux-x64.tar.gz
 *   AnTaTime-1.6.0-windows-x64-setup.exe
 *   antatime-1.6.0-windows-x64.zip
 *   AnTaTime-1.6.0-macos.dmg
 *
 * `GET /updates/latest.json` nennt je Paketart die höchste Version samt
 * Größe und SHA-256, `GET /updates/<datei>` liefert das Paket. Alte Pakete
 * dürfen liegen bleiben; andere Dateien im Verzeichnis sind nicht abrufbar.
 */

export type UpdatePlatform = 'android' | 'linux' | 'windows' | 'macos';
export type UpdateKind = 'apk' | 'appimage' | 'deb' | 'tar' | 'exe' | 'zip' | 'dmg';
export type UpdateArch = 'x64' | 'arm64';

export interface UpdateFile {
  platform: UpdatePlatform;
  kind: UpdateKind;
  /** `null` = für alle Architekturen (APK, macOS). */
  arch: UpdateArch | null;
  version: string;
}

export interface UpdatePackage extends UpdateFile {
  file: string;
  size: number;
  sha256: string;
}

export interface UpdateManifest {
  packages: UpdatePackage[];
}

const VERSION = String.raw`(\d+(?:\.\d+){1,3})`;
const PATTERNS: { re: RegExp; platform: UpdatePlatform; kind: UpdateKind }[] = [
  { re: new RegExp(`^antatime-${VERSION}\\.apk$`), platform: 'android', kind: 'apk' },
  {
    re: new RegExp(`^AnTaTime-${VERSION}-(x86_64|aarch64)\\.AppImage$`),
    platform: 'linux',
    kind: 'appimage',
  },
  { re: new RegExp(`^antatime_${VERSION}_(amd64|arm64)\\.deb$`), platform: 'linux', kind: 'deb' },
  {
    re: new RegExp(`^antatime-${VERSION}-linux-(x64|arm64)\\.tar\\.gz$`),
    platform: 'linux',
    kind: 'tar',
  },
  {
    re: new RegExp(`^AnTaTime-${VERSION}-windows-(x64)-setup\\.exe$`),
    platform: 'windows',
    kind: 'exe',
  },
  {
    re: new RegExp(`^antatime-${VERSION}-windows-(x64)\\.zip$`),
    platform: 'windows',
    kind: 'zip',
  },
  { re: new RegExp(`^AnTaTime-${VERSION}-macos\\.dmg$`), platform: 'macos', kind: 'dmg' },
];

const ARCH: { [name: string]: UpdateArch } = {
  x86_64: 'x64',
  amd64: 'x64',
  x64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
};

const MIME: { [kind in UpdateKind]: string } = {
  apk: 'application/vnd.android.package-archive',
  appimage: 'application/octet-stream',
  deb: 'application/vnd.debian.binary-package',
  tar: 'application/gzip',
  exe: 'application/vnd.microsoft.portable-executable',
  zip: 'application/zip',
  dmg: 'application/x-apple-diskimage',
};

/** Erkennt ein Paket am Dateinamen; `null` für alles andere. */
export function parseUpdateFile(name: string): UpdateFile | null {
  for (const { re, platform, kind } of PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    return { platform, kind, arch: m[2] ? ARCH[m[2]]! : null, version: m[1]! };
  }
  return null;
}

/** Vergleicht Versionen wie `1.10.0` und `1.9.3` zahlenweise. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** So lange gilt ein gelesenes Verzeichnis, damit Abfragen die Platte nicht fluten. */
const SCAN_TTL_MS = 10_000;

export class Updates {
  readonly dir: string;
  private readonly hashes = new Map<string, { mtime: number; size: number; sha256: Promise<string> }>();
  private scan: { at: number; manifest: Promise<UpdateManifest> } | null = null;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** Je Paketart und Architektur die höchste Version. */
  manifest(): Promise<UpdateManifest> {
    const now = Date.now();
    if (this.scan && now - this.scan.at < SCAN_TTL_MS) return this.scan.manifest;
    const scan = { at: now, manifest: this.read() };
    this.scan = scan;
    // Ein Fehler (Verzeichnis fehlt, Datei gerade ersetzt) soll nicht hängen bleiben.
    scan.manifest.catch(() => {
      if (this.scan === scan) this.scan = null;
    });
    return scan.manifest;
  }

  private async read(): Promise<UpdateManifest> {
    const newest = new Map<string, { name: string; info: UpdateFile }>();
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const info = parseUpdateFile(entry.name);
      if (!info) continue;
      const slot = `${info.kind}/${info.arch ?? ''}`;
      const best = newest.get(slot);
      if (!best || compareVersions(info.version, best.info.version) > 0) {
        newest.set(slot, { name: entry.name, info });
      }
    }
    const packages: UpdatePackage[] = [];
    for (const { name, info } of newest.values()) {
      const st = await stat(join(this.dir, name));
      packages.push({ ...info, file: name, size: st.size, sha256: await this.sha256(name, st) });
    }
    // Feste Reihenfolge, unabhängig von der Locale des Servers.
    packages.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { packages };
  }

  /** Die Prüfsumme wird je Datei nur einmal berechnet (bis sie sich ändert). */
  private sha256(name: string, st: { mtimeMs: number; size: number }): Promise<string> {
    const hit = this.hashes.get(name);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.sha256;
    const sha256 = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(this.dir, name))) hash.update(chunk);
      return hash.digest('hex');
    })();
    this.hashes.set(name, { mtime: st.mtimeMs, size: st.size, sha256 });
    sha256.catch(() => this.hashes.delete(name));
    return sha256;
  }

  /** Pfad und Größe eines Pakets; `undefined`, wenn es keines ist oder fehlt. */
  async file(name: string): Promise<{ path: string; size: number; type: string } | undefined> {
    // Nur Namen, die wie ein Paket aussehen – damit auch kein Pfad nach außen.
    const info = parseUpdateFile(name);
    if (!info) return undefined;
    const path = join(this.dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) return undefined;
      return { path, size: st.size, type: MIME[info.kind] };
    } catch {
      return undefined;
    }
  }
}

const PREFIX = '/updates/';

/** Beantwortet `/updates/…`. Gibt `false` zurück, wenn der Pfad nicht dazugehört. */
export async function serveUpdates(
  updates: Updates,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  if (!path.startsWith(PREFIX)) return false;
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const name = path.slice(PREFIX.length);

  if (name === 'latest.json') {
    const body = Buffer.from(JSON.stringify(await updates.manifest()));
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    });
    res.end(head ? undefined : body);
    return true;
  }

  const file = await updates.file(name);
  if (!file) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'not found' }));
    return true;
  }
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': String(file.size),
    // Ein Paket kann unter demselben Namen neu gebaut werden.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    // Im Browser (macOS-Update) speichern statt anzeigen.
    'content-disposition': `attachment; filename="${name}"`,
  });
  if (head) {
    res.end();
    return true;
  }
  try {
    await pipeline(createReadStream(file.path), res);
  } catch {
    // Abgebrochener Download oder Lesefehler: Die Kopfzeilen sind schon raus.
    res.destroy();
  }
  return true;
}
