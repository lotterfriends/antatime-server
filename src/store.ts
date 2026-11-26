import { randomInt } from 'node:crypto';

import { ErrorCode, ProtocolError } from './protocol.ts';
import type { SyncRecord, StoredRecord } from './protocol.ts';

/** Speicher-Kontingent, 0 = unbegrenzt. */
export interface Quota {
  /** pro Vault */
  maxRecords: number;
  /** pro Vault */
  maxBytes: number;
  /** über alle Vaults des Servers */
  maxTotalBytes: number;
  /** Höchstzahl an Vaults mit Daten auf dem Server */
  maxVaults: number;
}

export const SERVER_FULL_MESSAGE =
  'Dieser Server hat die maximale Anzahl an Nutzern erreicht und nimmt keine neuen Sync-Codes an';

export function serverFull(): ProtocolError {
  return new ProtocolError(ErrorCode.serverFull, SERVER_FULL_MESSAGE);
}

export interface Usage {
  records: number;
  bytes: number;
}

/**
 * Belegung nach dem Speichern von [records]; wirft, wenn das Kontingent
 * überschritten würde. [existing] = aktuelle Größe der bereits gespeicherten
 * Schlüssel (hex). Änderungen, die nichts vergrößern, gehen immer durch,
 * damit ein voller Vault noch löschen und verkleinern kann.
 */
export function applyQuota(
  usage: Usage,
  existing: Map<string, number>,
  records: SyncRecord[],
  quota: Quota,
  totalBytes: number,
): Usage {
  const latest = new Map<string, number>();
  for (const r of records) latest.set(r.key.toString('hex'), r.data.length);
  let added = 0;
  let delta = 0;
  for (const [k, len] of latest) {
    const old = existing.get(k);
    if (old === undefined) added++;
    delta += len - (old ?? 0);
  }
  const next = { records: usage.records + added, bytes: Math.max(0, usage.bytes + delta) };
  if (
    (quota.maxRecords > 0 && added > 0 && next.records > quota.maxRecords) ||
    (quota.maxBytes > 0 && delta > 0 && next.bytes > quota.maxBytes)
  ) {
    throw new ProtocolError(ErrorCode.quotaExceeded, 'Speicherplatz für diesen Sync-Code ist voll');
  }
  if (quota.maxTotalBytes > 0 && delta > 0 && totalBytes + delta > quota.maxTotalBytes) {
    throw new ProtocolError(ErrorCode.quotaExceeded, 'Speicherplatz des Servers ist voll');
  }
  return next;
}

/**
 * Neue Epoche für einen (neu) angelegten Vault: zufällig, 48 Bit, nie 0
 * (0 = Vault fehlt oder stammt aus der Zeit vor den Epochen).
 */
export function newEpoch(): number {
  return randomInt(1, 2 ** 48);
}

export interface Head {
  seq: number;
  /** Code wurde gelöscht und ist verbrannt. */
  deleted: boolean;
  /**
   * Wechselt, wenn der Vault neu angelegt wird (z. B. nach dem Ablauf).
   * Sequenznummern sind nur innerhalb einer Epoche vergleichbar.
   */
  epoch: number;
}

/** Speicher für die verschlüsselten Datensätze (MySQL oder im Speicher für Tests). */
export interface Store {
  head(vault: Buffer): Promise<Head>;
  changesSince(vault: Buffer, after: number, limit: number): Promise<StoredRecord[]>;
  /**
   * Erste vergebene Sequenznummer, `null` wenn der Vault gelöscht ist. Wirft
   * `serverFull`, wenn es die ersten Daten des Vaults wären und der Server
   * bereits `quota.maxVaults` Vaults mit Daten hat.
   */
  put(vault: Buffer, records: SyncRecord[], quota: Quota): Promise<number | null>;
  deleteVault(vault: Buffer): Promise<void>;
  /**
   * Merkt sich, dass ein Gerät den Vault gerade benutzt, und legt ihn an,
   * falls er fehlt – damit schon das erste SYNCED die endgültige Epoche trägt.
   */
  touch(vault: Buffer): Promise<void>;
  /**
   * Zahl der belegten Plätze für `MAX_VAULTS`: Vaults mit Daten, die nicht
   * gelöscht sind. Leere Vaults (nur verbunden, nie etwas hochgeladen)
   * zählen nicht – sonst ließe sich der Server mit bloßen Verbindungen füllen.
   */
  vaultCount(): Promise<number>;
  /**
   * Entfernt Vaults (auch gelöschte), die seit [before] nicht benutzt wurden,
   * vollständig. Kommt ein Gerät später zurück, lädt es seine Daten neu hoch.
   * Vaults, für die [keep] `true` liefert, bleiben. Gibt die Zahl der
   * entfernten Vaults zurück.
   */
  expire(before: Date, keep?: (vault: Buffer) => boolean): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface MemoryVault {
  seq: number;
  deleted: boolean;
  epoch: number;
  records: Map<string, StoredRecord>;
  activeAt: number;
}

/** Flüchtiger Speicher – für Tests und schnelles Ausprobieren ohne Datenbank. */
export class MemoryStore implements Store {
  private readonly vaults = new Map<string, MemoryVault>();

  private vault(id: Buffer): MemoryVault {
    const k = id.toString('hex');
    let v = this.vaults.get(k);
    if (!v) {
      v = { seq: 0, deleted: false, epoch: newEpoch(), records: new Map(), activeAt: Date.now() };
      this.vaults.set(k, v);
    }
    return v;
  }

  async head(id: Buffer) {
    const v = this.vaults.get(id.toString('hex'));
    return { seq: v?.seq ?? 0, deleted: v?.deleted ?? false, epoch: v?.epoch ?? 0 };
  }

  async changesSince(id: Buffer, after: number, limit: number) {
    const v = this.vaults.get(id.toString('hex'));
    if (!v) return [];
    return [...v.records.values()]
      .filter((r) => r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async put(id: Buffer, records: SyncRecord[], quota: Quota) {
    const v = this.vault(id);
    if (v.deleted) return null;
    if (quota.maxVaults > 0 && v.seq === 0 && (await this.vaultCount()) >= quota.maxVaults) throw serverFull();
    const existing = new Map<string, number>();
    let bytes = 0;
    for (const [k, r] of v.records) {
      existing.set(k, r.data.length);
      bytes += r.data.length;
    }
    let total = 0;
    for (const o of this.vaults.values()) for (const r of o.records.values()) total += r.data.length;
    applyQuota({ records: v.records.size, bytes }, existing, records, quota, total);
    v.activeAt = Date.now();
    const first = v.seq + 1;
    for (const r of records) {
      v.seq++;
      v.records.set(r.key.toString('hex'), { ...r, seq: v.seq });
    }
    return first;
  }

  async deleteVault(id: Buffer) {
    const v = this.vault(id);
    v.deleted = true;
    v.records.clear();
    v.activeAt = Date.now();
  }

  async touch(id: Buffer) {
    this.vault(id).activeAt = Date.now();
  }

  async vaultCount() {
    let n = 0;
    for (const v of this.vaults.values()) if (v.seq > 0 && !v.deleted) n++;
    return n;
  }

  async expire(before: Date, keep?: (vault: Buffer) => boolean) {
    let n = 0;
    for (const [k, v] of this.vaults) {
      if (v.activeAt < before.getTime() && !keep?.(Buffer.from(k, 'hex'))) {
        this.vaults.delete(k);
        n++;
      }
    }
    return n;
  }

  async ping() {}
  async close() {}
}
