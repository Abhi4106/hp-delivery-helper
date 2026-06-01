import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { ConsumerRecord } from "../types";

type WebState = {
  consumers: Record<string, ConsumerRecord>;
  meta: Record<string, string>;
};

const WEB_DB_KEY = "hp_delivery_helper_web_db";

const toTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

class LocalDb {
  private sqlite: SQLiteConnection | null = null;
  private db: SQLiteDBConnection | null = null;
  private webState: WebState = { consumers: {}, meta: {} };

  async init(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        this.sqlite = new SQLiteConnection(CapacitorSQLite);
        const consistency = await this.sqlite.checkConnectionsConsistency();
        const isConnected = (await this.sqlite.isConnection("hp_delivery_helper", false)).result;

        if (consistency.result && isConnected) {
          this.db = await this.sqlite.retrieveConnection("hp_delivery_helper", false);
        } else {
          this.db = await this.sqlite.createConnection("hp_delivery_helper", false, "no-encryption", 1, false);
        }

        await this.db.open();
        await this.createTables();
        return;
      } catch (error) {
        console.error("SQLite init failed, falling back to web storage", error);
      }
    }

    this.loadWebState();
  }

  private async createTables(): Promise<void> {
    if (!this.db) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS consumers (
        consumerNumber TEXT PRIMARY KEY NOT NULL,
        consumerName TEXT NOT NULL,
        mobileNumber TEXT NOT NULL,
        landmark TEXT NOT NULL,
        imagePath TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        locationTimestamp TEXT NOT NULL,
        createdDate TEXT NOT NULL,
        updatedDate TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        syncStatus TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
  }

  private loadWebState(): void {
    const raw = localStorage.getItem(WEB_DB_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as WebState;
      this.webState = {
        consumers: parsed.consumers ?? {},
        meta: parsed.meta ?? {},
      };
    } catch {
      this.webState = { consumers: {}, meta: {} };
    }
  }

  private saveWebState(): void {
    localStorage.setItem(WEB_DB_KEY, JSON.stringify(this.webState));
  }

  private normalizeRow(row: Record<string, unknown>): ConsumerRecord {
    return {
      consumerNumber: String(row.consumerNumber ?? ""),
      consumerName: String(row.consumerName ?? ""),
      mobileNumber: String(row.mobileNumber ?? ""),
      landmark: String(row.landmark ?? ""),
      imagePath: String(row.imagePath ?? ""),
      latitude: Number(row.latitude ?? 0),
      longitude: Number(row.longitude ?? 0),
      locationTimestamp: String(row.locationTimestamp ?? ""),
      createdDate: String(row.createdDate ?? ""),
      updatedDate: String(row.updatedDate ?? ""),
      deleted: Number(row.deleted ?? 0) === 1,
      syncStatus: String(row.syncStatus ?? "pending") === "synced" ? "synced" : "pending",
    };
  }

  async getAllConsumers(includeDeleted = false): Promise<ConsumerRecord[]> {
    if (this.db) {
      const where = includeDeleted ? "" : "WHERE deleted = 0";
      const result = await this.db.query(`SELECT * FROM consumers ${where} ORDER BY updatedDate DESC`);
      return (result.values ?? []).map((row) => this.normalizeRow(row));
    }

    const values = Object.values(this.webState.consumers).sort((a, b) => toTimestamp(b.updatedDate) - toTimestamp(a.updatedDate));
    return includeDeleted ? values : values.filter((item) => !item.deleted);
  }

  async getConsumerByNumber(consumerNumber: string): Promise<ConsumerRecord | null> {
    if (this.db) {
      const result = await this.db.query("SELECT * FROM consumers WHERE consumerNumber = ? LIMIT 1", [consumerNumber]);
      const row = result.values?.[0];
      return row ? this.normalizeRow(row) : null;
    }

    return this.webState.consumers[consumerNumber] ?? null;
  }

  async searchConsumers(term: string): Promise<ConsumerRecord[]> {
    const query = term.trim().toLowerCase();
    if (!query) return this.getAllConsumers(false);

    if (this.db) {
      const wildcard = `%${query}%`;
      const result = await this.db.query(
        `
          SELECT * FROM consumers
          WHERE deleted = 0
          AND (
            LOWER(consumerNumber) LIKE ?
            OR LOWER(consumerName) LIKE ?
            OR LOWER(mobileNumber) LIKE ?
            OR LOWER(landmark) LIKE ?
          )
          ORDER BY updatedDate DESC
        `,
        [wildcard, wildcard, wildcard, wildcard],
      );

      return (result.values ?? []).map((row) => this.normalizeRow(row));
    }

    return Object.values(this.webState.consumers)
      .filter((item) => {
        if (item.deleted) return false;
        const stack = `${item.consumerNumber} ${item.consumerName} ${item.mobileNumber} ${item.landmark}`.toLowerCase();
        return stack.includes(query);
      })
      .sort((a, b) => toTimestamp(b.updatedDate) - toTimestamp(a.updatedDate));
  }

  async upsertConsumer(consumer: ConsumerRecord): Promise<void> {
    if (this.db) {
      await this.db.run(
        `
          INSERT INTO consumers (
            consumerNumber, consumerName, mobileNumber, landmark, imagePath,
            latitude, longitude, locationTimestamp, createdDate, updatedDate, deleted, syncStatus
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(consumerNumber) DO UPDATE SET
            consumerName = excluded.consumerName,
            mobileNumber = excluded.mobileNumber,
            landmark = excluded.landmark,
            imagePath = excluded.imagePath,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            locationTimestamp = excluded.locationTimestamp,
            createdDate = excluded.createdDate,
            updatedDate = excluded.updatedDate,
            deleted = excluded.deleted,
            syncStatus = excluded.syncStatus
        `,
        [
          consumer.consumerNumber,
          consumer.consumerName,
          consumer.mobileNumber,
          consumer.landmark,
          consumer.imagePath,
          consumer.latitude,
          consumer.longitude,
          consumer.locationTimestamp,
          consumer.createdDate,
          consumer.updatedDate,
          consumer.deleted ? 1 : 0,
          consumer.syncStatus,
        ],
      );
      return;
    }

    this.webState.consumers[consumer.consumerNumber] = consumer;
    this.saveWebState();
  }

  async getPendingConsumers(): Promise<ConsumerRecord[]> {
    if (this.db) {
      const result = await this.db.query("SELECT * FROM consumers WHERE syncStatus = 'pending' ORDER BY updatedDate ASC");
      return (result.values ?? []).map((row) => this.normalizeRow(row));
    }

    return Object.values(this.webState.consumers)
      .filter((item) => item.syncStatus === "pending")
      .sort((a, b) => toTimestamp(a.updatedDate) - toTimestamp(b.updatedDate));
  }

  async markSynced(consumerNumber: string): Promise<void> {
    if (this.db) {
      await this.db.run("UPDATE consumers SET syncStatus = 'synced' WHERE consumerNumber = ?", [consumerNumber]);
      return;
    }

    const existing = this.webState.consumers[consumerNumber];
    if (existing) {
      this.webState.consumers[consumerNumber] = { ...existing, syncStatus: "synced" };
      this.saveWebState();
    }
  }

  async getPendingCount(): Promise<number> {
    if (this.db) {
      const result = await this.db.query("SELECT COUNT(*) as total FROM consumers WHERE syncStatus = 'pending'");
      return Number(result.values?.[0]?.total ?? 0);
    }

    return Object.values(this.webState.consumers).filter((item) => item.syncStatus === "pending").length;
  }

  async getMeta(key: string): Promise<string | null> {
    if (this.db) {
      const result = await this.db.query("SELECT value FROM meta WHERE key = ? LIMIT 1", [key]);
      const value = result.values?.[0]?.value;
      return typeof value === "string" ? value : null;
    }

    return this.webState.meta[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    if (this.db) {
      await this.db.run(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
      );
      return;
    }

    this.webState.meta[key] = value;
    this.saveWebState();
  }
}

export const localDb = new LocalDb();