/**
 * Bridge-local state (better-sqlite3): the last seen hub event seq and the
 * hub message id <-> Discord message id map. Not the hub's database; the
 * bridge never opens that.
 */
import Database from 'better-sqlite3';

export interface MessageLink {
  hubMessageId: string;
  discordMessageId: string;
  roomId: string;
  createdAt: number;
}

export class BridgeState {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_map (
        hub_message_id TEXT PRIMARY KEY,
        discord_message_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_map_created ON message_map(created_at);
    `);
  }

  get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM bridge_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO bridge_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Last handled hub event seq, or null before the first batch. */
  getSeq(): number | null {
    const v = this.get('seq');
    return v === undefined ? null : Number(v);
  }

  setSeq(seq: number): void {
    this.set('seq', String(seq));
  }

  putLink(link: MessageLink): void {
    this.db
      .prepare('INSERT OR REPLACE INTO message_map(hub_message_id, discord_message_id, room_id, created_at) VALUES(?, ?, ?, ?)')
      .run(link.hubMessageId, link.discordMessageId, link.roomId, link.createdAt);
  }

  private fromRow(r: { hub_message_id: string; discord_message_id: string; room_id: string; created_at: number } | undefined): MessageLink | undefined {
    return r && { hubMessageId: r.hub_message_id, discordMessageId: r.discord_message_id, roomId: r.room_id, createdAt: r.created_at };
  }

  byHub(hubMessageId: string): MessageLink | undefined {
    return this.fromRow(this.db.prepare('SELECT * FROM message_map WHERE hub_message_id = ?').get(hubMessageId) as never);
  }

  byDiscord(discordMessageId: string): MessageLink | undefined {
    return this.fromRow(this.db.prepare('SELECT * FROM message_map WHERE discord_message_id = ?').get(discordMessageId) as never);
  }

  /** Drop links created before `cutoff` (epoch ms); returns how many. */
  pruneOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM message_map WHERE created_at < ?').run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }
}
