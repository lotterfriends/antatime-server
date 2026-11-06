import type { SyncRecord, StoredRecord } from './protocol.ts';

/** Speicher für die verschlüsselten Datensätze (MySQL oder im Speicher für Tests). */
export interface Store {
  head(vault: Buffer): Promise<{ seq: number; deleted: boolean }>;
  changesSince(vault: Buffer, after: number, limit: number): Promise<StoredRecord[]>;
  /** Erste vergebene Sequenznummer, `null` wenn der Vault gelöscht ist. */
  put(vault: Buffer, records: SyncRecord[]): Promise<number | null>;
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

  async put(id: Buffer, records: SyncRecord[]) {
    const v = this.vault(id);
    if (v.deleted) return null;
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
