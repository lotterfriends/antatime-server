import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';

import type { DbConfig } from './config.ts';
import type { SyncRecord, StoredRecord } from './protocol.ts';
import { applyQuota } from './store.ts';
import type { Quota, Store } from './store.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vaults (
     id         BINARY(32)      NOT NULL,
     seq        BIGINT UNSIGNED NOT NULL DEFAULT 0,
     deleted    BOOLEAN         NOT NULL DEFAULT FALSE,
     records    INT UNSIGNED    NOT NULL DEFAULT 0,
     bytes      BIGINT UNSIGNED NOT NULL DEFAULT 0,
     created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     active_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY by_active (active_at)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS records (
     vault BINARY(32)      NOT NULL,
     rkey  BINARY(16)      NOT NULL,
     seq   BIGINT UNSIGNED NOT NULL,
     data  BLOB            NOT NULL,
     PRIMARY KEY (vault, rkey),
     KEY by_seq (vault, seq),
     CONSTRAINT fk_records_vault FOREIGN KEY (vault) REFERENCES vaults (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
];

/** So lange gilt die zwischengespeicherte Gesamtbelegung des Servers. */
const TOTAL_TTL_MS = 10_000;
/** Vaults pro Lösch-Durchgang beim Ablauf. */
const EXPIRE_BATCH = 500;

export class Database implements Store {
  private readonly pool: Pool;
  /** Gesamtbelegung aller Vaults; zwischen zwei Abfragen fortgeschrieben. */
  private total: { bytes: number; at: number } | null = null;

  constructor(config: DbConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      supportBigNumbers: true,
      bigNumberStrings: false,
      enableKeepAlive: true,
    });
  }

  /** Wartet auf die Datenbank (z. B. beim Start im Container) und legt das Schema an. */
  async init(retries = 30): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        for (const sql of SCHEMA) await this.pool.query(sql);
        await this.migrate();
        return;
      } catch (e) {
        if (attempt >= retries) throw e;
        console.warn(`Datenbank nicht erreichbar (${(e as Error).message}), neuer Versuch …`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Ältere Datenbanken: fehlende Spalten ergänzen und befüllen. */
  private async migrate(): Promise<void> {
    const [cols] = await this.pool.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vaults'",
    );
    const have = new Set(cols.map((c) => String(c['COLUMN_NAME']).toLowerCase()));
    if (!have.has('bytes')) await this.migrateQuota();
    if (!have.has('active_at')) {
      console.log('Datenbank: ergänze Spalte für den Ablauf inaktiver Vaults …');
      await this.pool.query(
        'ALTER TABLE vaults ADD COLUMN active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD KEY by_active (active_at)',
      );
      await this.pool.query('UPDATE vaults SET active_at = updated_at, updated_at = updated_at');
    }
  }

  private async migrateQuota(): Promise<void> {
    console.log('Datenbank: ergänze Kontingent-Spalten …');
    await this.pool.query(
      'ALTER TABLE vaults ADD COLUMN records INT UNSIGNED NOT NULL DEFAULT 0 AFTER deleted, ' +
        'ADD COLUMN bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER records',
    );
    await this.pool.query(
      'UPDATE vaults v JOIN (SELECT vault, COUNT(*) AS n, SUM(LENGTH(data)) AS b FROM records GROUP BY vault) r ' +
        'ON r.vault = v.id SET v.records = r.n, v.bytes = r.b',
    );
  }

  /** Gesamtbelegung aller Vaults, höchstens [TOTAL_TTL_MS] alt. */
  private async totalBytes(): Promise<number> {
    const now = Date.now();
    if (!this.total || now - this.total.at > TOTAL_TTL_MS) {
      const [rows] = await this.pool.query<RowDataPacket[]>('SELECT COALESCE(SUM(bytes), 0) AS b FROM vaults');
      this.total = { bytes: Number(rows[0]!['b']), at: now };
    }
    return this.total.bytes;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Stand des Vaults; `deleted` = Code wurde gelöscht und ist verbrannt. */
  async head(vault: Buffer): Promise<{ seq: number; deleted: boolean }> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT seq, deleted FROM vaults WHERE id = ?',
      [vault],
    );
    if (!rows.length) return { seq: 0, deleted: false };
    return { seq: Number(rows[0]!['seq']), deleted: Boolean(rows[0]!['deleted']) };
  }

  /** Datensätze mit seq > [after], aufsteigend, höchstens [limit]. */
  async changesSince(vault: Buffer, after: number, limit: number): Promise<StoredRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT seq, rkey, data FROM records WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?',
      [vault, after, limit],
    );
    return rows.map((r) => ({
      seq: Number(r['seq']),
      key: r['rkey'] as Buffer,
      data: r['data'] as Buffer,
    }));
  }

  /**
   * Speichert [records] und vergibt fortlaufende Sequenznummern.
   * Gibt die erste vergebene Nummer zurück, `null` wenn der Vault gelöscht ist.
   */
  async put(vault: Buffer, records: SyncRecord[], quota: Quota): Promise<number | null> {
    const n = records.length;
    const total = quota.maxTotalBytes > 0 ? await this.totalBytes() : 0;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT IGNORE INTO vaults (id) VALUES (?)', [vault]);
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT seq, deleted, records, bytes FROM vaults WHERE id = ? FOR UPDATE',
        [vault],
      );
      const head = rows[0]!;
      if (head['deleted']) {
        await conn.rollback();
        return null;
      }
      const [old] = await conn.query<RowDataPacket[]>(
        'SELECT rkey, LENGTH(data) AS len FROM records WHERE vault = ? AND rkey IN (?)',
        [vault, records.map((r) => r.key)],
      );
      const existing = new Map(old.map((r) => [(r['rkey'] as Buffer).toString('hex'), Number(r['len'])]));
      const usage = applyQuota(
        { records: Number(head['records']), bytes: Number(head['bytes']) },
        existing,
        records,
        quota,
        total,
      );
      const first = Number(head['seq']) + 1;
      await conn.query('UPDATE vaults SET seq = ?, records = ?, bytes = ?, active_at = NOW() WHERE id = ?', [
        first + n - 1,
        usage.records,
        usage.bytes,
        vault,
      ]);
      const values = records.map((r, i) => [vault, r.key, first + i, r.data]);
      await conn.query(
        'INSERT INTO records (vault, rkey, seq, data) VALUES ? AS new ' +
          'ON DUPLICATE KEY UPDATE seq = new.seq, data = new.data',
        [values],
      );
      await conn.commit();
      if (this.total) this.total.bytes += usage.bytes - Number(head['bytes']);
      return first;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Löscht alle Daten des Vaults. Der Eintrag selbst bleibt als „gelöscht“
   * markiert, damit Geräte, die gerade offline sind, beim nächsten Verbinden
   * davon erfahren (der Code ist danach nicht mehr verwendbar).
   */
  async deleteVault(vault: Buffer): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM records WHERE vault = ?', [vault]);
      await conn.query(
        'INSERT INTO vaults (id, deleted) VALUES (?, TRUE) ' +
          'ON DUPLICATE KEY UPDATE deleted = TRUE, records = 0, bytes = 0, active_at = NOW()',
        [vault],
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async touch(vault: Buffer): Promise<void> {
    // Höchstens einmal pro Stunde schreiben, sonst kostet jedes HELLO ein UPDATE.
    await this.pool.query(
      'UPDATE vaults SET active_at = NOW() WHERE id = ? AND active_at < NOW() - INTERVAL 1 HOUR',
      [vault],
    );
  }

  async expire(before: Date): Promise<number> {
    // Relativ zu NOW() rechnen: Ein Date-Parameter würde in der Zeitzone von
    // Node übergeben, verglichen wird aber in der Zeitzone der Datenbank.
    const age = Math.round((Date.now() - before.getTime()) / 1000);
    let removed = 0;
    for (;;) {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT id FROM vaults WHERE active_at < NOW() - INTERVAL ? SECOND LIMIT ?',
        [age, EXPIRE_BATCH],
      );
      if (!rows.length) break;
      for (const row of rows) {
        // Einzeln und erneut geprüft: Ein Gerät kann sich inzwischen gemeldet haben.
        const conn = await this.pool.getConnection();
        try {
          await conn.beginTransaction();
          const [hit] = await conn.query<RowDataPacket[]>(
            'SELECT id FROM vaults WHERE id = ? AND active_at < NOW() - INTERVAL ? SECOND FOR UPDATE',
            [row['id'], age],
          );
          if (hit.length) {
            await conn.query('DELETE FROM records WHERE vault = ?', [row['id']]);
            await conn.query('DELETE FROM vaults WHERE id = ?', [row['id']]);
            removed++;
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback().catch(() => {});
          throw e;
        } finally {
          conn.release();
        }
      }
      if (rows.length < EXPIRE_BATCH) break;
    }
    if (removed) this.total = null;
    return removed;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
