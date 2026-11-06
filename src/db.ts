import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';

import type { DbConfig } from './config.ts';
import type { SyncRecord, StoredRecord } from './protocol.ts';
import type { Store } from './store.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vaults (
     id         BINARY(32)      NOT NULL,
     seq        BIGINT UNSIGNED NOT NULL DEFAULT 0,
     deleted    BOOLEAN         NOT NULL DEFAULT FALSE,
     created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id)
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

export class Database implements Store {
  private readonly pool: Pool;

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
        return;
      } catch (e) {
        if (attempt >= retries) throw e;
        console.warn(`Datenbank nicht erreichbar (${(e as Error).message}), neuer Versuch …`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
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
  async put(vault: Buffer, records: SyncRecord[]): Promise<number | null> {
    const n = records.length;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT IGNORE INTO vaults (id) VALUES (?)', [vault]);
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT seq, deleted FROM vaults WHERE id = ? FOR UPDATE',
        [vault],
      );
      if (rows[0]!['deleted']) {
        await conn.rollback();
        return null;
      }
      const first = Number(rows[0]!['seq']) + 1;
      await conn.query('UPDATE vaults SET seq = ? WHERE id = ?', [first + n - 1, vault]);
      const values = records.map((r, i) => [vault, r.key, first + i, r.data]);
      await conn.query(
        'INSERT INTO records (vault, rkey, seq, data) VALUES ? AS new ' +
          'ON DUPLICATE KEY UPDATE seq = new.seq, data = new.data',
        [values],
      );
      await conn.commit();
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
        'INSERT INTO vaults (id, deleted) VALUES (?, TRUE) ON DUPLICATE KEY UPDATE deleted = TRUE',
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
