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
  /** Gleichzeitige Verbindungen insgesamt (0 = unbegrenzt). */
  maxConnections: number;
  /** Gleichzeitige Verbindungen pro Client-IP bzw. IPv6-/64 (0 = unbegrenzt). */
  maxConnectionsPerIp: number;
  /** Neue Verbindungen pro Client-IP und Minute (0 = unbegrenzt). */
  connectsPerIpPerMinute: number;
  /** Hochgeladene Bytes pro Client-IP und Minute (0 = unbegrenzt). */
  uploadBytesPerIpPerMinute: number;
  /** Header mit der Client-IP hinter einem Reverse-Proxy; leer = Socket-Adresse. */
  clientIpHeader: string;
  /** Ohne HELLO innerhalb dieser Zeit wird die Verbindung getrennt. */
  helloTimeoutMs: number;
  /** Kontingent pro Vault (0 = unbegrenzt). */
  maxVaultRecords: number;
  maxVaultBytes: number;
  /** Ungelesene Sendedaten pro Verbindung; darüber wird die Verbindung getrennt. */
  maxSendBufferBytes: number;
  /** So lange darf ein Client beim Nachholen nichts lesen, bevor er getrennt wird. */
  sendStallTimeoutMs: number;
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
    maxConnections: int(env, 'MAX_CONNECTIONS', 5000),
    maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 20),
    connectsPerIpPerMinute: int(env, 'CONNECTS_PER_IP_PER_MINUTE', 30),
    uploadBytesPerIpPerMinute: int(env, 'UPLOAD_BYTES_PER_IP_PER_MINUTE', 10 * 1024 * 1024),
    clientIpHeader: (env['CLIENT_IP_HEADER'] ?? '').trim().toLowerCase(),
    helloTimeoutMs: int(env, 'HELLO_TIMEOUT_MS', 10_000),
    maxVaultRecords: int(env, 'MAX_VAULT_RECORDS', 100_000),
    maxVaultBytes: int(env, 'MAX_VAULT_BYTES', 64 * 1024 * 1024),
    maxSendBufferBytes: int(env, 'MAX_SEND_BUFFER_BYTES', 4 * 1024 * 1024),
    sendStallTimeoutMs: int(env, 'SEND_STALL_TIMEOUT_MS', 30_000),
  };
}
