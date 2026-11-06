export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
}

export interface Config {
  host: string;
  port: number;
  db: DbConfig;
  /** Verzeichnis eines Flutter-Web-Builds; leer = eingebetteter Build, `off` = keine Web-App. */
  webDir: string;
  /** Maximale Größe eines verschlüsselten Datensatzes in Bytes. */
  maxRecordBytes: number;
  maxRecordsPerPush: number;
  /** Maximale Größe einer WebSocket-Nachricht in Bytes. */
  maxMessageBytes: number;
  /** Maximale Anzahl gleichzeitiger Verbindungen pro Vault (0 = unbegrenzt). */
  maxConnectionsPerVault: number;
  /** Erlaubte Nachrichten pro Sekunde und Verbindung (Mittelwert, Burst = 10×). */
  messagesPerSecond: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} muss eine ganze Zahl sein`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let db: DbConfig = {
    host: env['DB_HOST'] ?? 'localhost',
    port: int(env, 'DB_PORT', 3306),
    user: env['DB_USER'] ?? 'antatime',
    password: env['DB_PASSWORD'] ?? '',
    database: env['DB_NAME'] ?? 'antatime',
    connectionLimit: int(env, 'DB_CONNECTION_LIMIT', 10),
  };
  // Alternativ alles in einer URL: mysql://user:pass@host:3306/db
  if (env['DATABASE_URL']) {
    const u = new URL(env['DATABASE_URL']);
    db = {
      ...db,
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || db.database,
    };
  }
  return {
    host: env['HOST'] ?? '0.0.0.0',
    port: int(env, 'PORT', 8080),
    db,
    webDir: env['WEB_DIR'] ?? '',
    maxRecordBytes: int(env, 'MAX_RECORD_BYTES', 16 * 1024),
    maxRecordsPerPush: int(env, 'MAX_RECORDS_PER_PUSH', 1000),
    maxMessageBytes: int(env, 'MAX_MESSAGE_BYTES', 4 * 1024 * 1024),
    maxConnectionsPerVault: int(env, 'MAX_CONNECTIONS_PER_VAULT', 0),
    messagesPerSecond: int(env, 'MESSAGES_PER_SECOND', 20),
  };
}
