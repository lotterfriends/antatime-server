import { loadConfig } from './config.ts';
import { Database } from './db.ts';
import { installFileLog } from './log.ts';
import { MemoryStore } from './store.ts';
import type { Store } from './store.ts';
import { SyncServer } from './sync-server.ts';
import { Updates } from './updates.ts';
import { DirectoryWebApp, EmbeddedWebApp } from './web-app.ts';
import type { WebApp } from './web-app.ts';
import embeddedWeb from './web-embedded.ts';

// Zuerst, damit auch Fehler in der Konfiguration in der Datei landen.
const logFile = process.env['LOG_FILE']?.trim();
if (logFile) {
  const raw = process.env['LOG_FILE_MAX_BYTES']?.trim();
  const max = raw ? Number(raw) : NaN;
  installFileLog(logFile, Number.isInteger(max) && max >= 0 ? max : undefined);
}

async function main(): Promise<void> {
  const config = loadConfig();
  let store: Store;
  if (process.env['STORE'] === 'memory') {
    console.warn('STORE=memory: Daten werden nur im Arbeitsspeicher gehalten.');
    store = new MemoryStore();
  } else {
    const db = new Database(config.db);
    await db.init();
    store = db;
  }

  // Web-App: WEB_DIR hat Vorrang vor dem eingebetteten Build,
  // WEB_DIR=off schaltet die Auslieferung ab.
  let web: WebApp | null = null;
  if (config.webDir === 'off') {
    web = null;
  } else if (config.webDir) {
    web = new DirectoryWebApp(config.webDir);
  } else if (embeddedWeb) {
    web = new EmbeddedWebApp(embeddedWeb);
  }

  const updates = config.updatesDir ? new Updates(config.updatesDir) : null;

  const server = new SyncServer(config, store, web, updates);
  const port = await server.listen();
  console.log(`AnTaTime-Sync läuft auf ${config.host}:${port} (WebSocket /sync, Status /health)`);
  console.log(web ? `Web-App unter / (${web.source})` : 'Keine Web-App (WEB_DIR nicht gesetzt)');
  if (updates) console.log(`App-Updates unter /updates/ (${updates.dir})`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} empfangen, beende …`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
