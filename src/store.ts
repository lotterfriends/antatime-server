import { ErrorCode, ProtocolError } from './protocol.ts';
import type { SyncRecord, StoredRecord } from './protocol.ts';

/** Speicher-Kontingent pro Vault, 0 = unbegrenzt. */
export interface Quota {
  maxRecords: number;
  maxBytes: number;
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
  return next;
}

/** Speicher für die verschlüsselten Datensätze (MySQL oder im Speicher für Tests). */
export interface Store {
  head(vault: Buffer): Promise<{ seq: number; deleted: boolean }>;
  changesSince(vault: Buffer, after: number, limit: number): Promise<StoredRecord[]>;
  /** Erste vergebene Sequenznummer, `null` wenn der Vault gelöscht ist. */
  put(vault: Buffer, records: SyncRecord[], quota: Quota): Promise<number | null>;
  deleteVault(vault: Buffer): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface MemoryVault {
  seq: number;
  deleted: boolean;
  records: Map<string, StoredRecord>;
}

/** Flüchtiger Speicher – für Tests und schnelles Ausprobieren ohne Datenbank. */
export class MemoryStore implements Store {
  private readonly vaults = new Map<string, MemoryVault>();

  private vault(id: Buffer): MemoryVault {
    const k = id.toString('hex');
    let v = this.vaults.get(k);
    if (!v) {
      v = { seq: 0, deleted: false, records: new Map() };
      this.vaults.set(k, v);
    }
    return v;
  }

  async head(id: Buffer) {
    const v = this.vaults.get(id.toString('hex'));
    return { seq: v?.seq ?? 0, deleted: v?.deleted ?? false };
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
    const existing = new Map<string, number>();
    let bytes = 0;
    for (const [k, r] of v.records) {
      existing.set(k, r.data.length);
      bytes += r.data.length;
    }
    applyQuota({ records: v.records.size, bytes }, existing, records, quota);
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
  }

  async ping() {}
  async close() {}
}
