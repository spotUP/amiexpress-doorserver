/**
 * Bridge-local state (better-sqlite3): the last seen hub event seq and the
 * hub message id <-> Discord message id map. Not the hub's database; the
 * bridge never opens that.
 *
 * One hub message has one twin per linked Discord channel (multi-guild,
 * 2026-11-12): the map is keyed by (hub message, channel). A Discord message
 * id is still unique, so byDiscord answers for any guild.
 */
import Database from 'better-sqlite3';

export interface MessageLink {
  hubMessageId: string;
  discordMessageId: string;
  roomId: string;
  /** Discord channel of the twin; '' only on a row older than multi-guild that no room claimed yet. */
  channelId?: string;
  /** True on the row of a Discord original (inbound); false on the bridge's webhook copies. */
  source?: boolean;
  createdAt: number;
  /** Display label and text of the hub message, so a later reply can quote it. */
  authorLabel?: string;
  content?: string;
}

interface Row {
  hub_message_id: string;
  channel_id: string;
  discord_message_id: string;
  room_id: string;
  created_at: number;
  author_label: string;
  content: string;
  source: number;
}

const MESSAGE_MAP_DDL = `
  CREATE TABLE IF NOT EXISTS message_map (
    hub_message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    discord_message_id TEXT NOT NULL UNIQUE,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    author_label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hub_message_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS message_map_created ON message_map(created_at);
`;

export class BridgeState {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS bridge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_map'").get();
    if (exists) {
      // A phase 2 file has no quote columns; add them in place.
      const cols = (this.db.prepare('PRAGMA table_info(message_map)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('author_label')) this.db.exec("ALTER TABLE message_map ADD COLUMN author_label TEXT NOT NULL DEFAULT ''");
      if (!cols.includes('content')) this.db.exec("ALTER TABLE message_map ADD COLUMN content TEXT NOT NULL DEFAULT ''");
      if (!cols.includes('channel_id')) this.migrateToPerChannel();
    }
    this.db.exec(MESSAGE_MAP_DDL);
  }

  /**
   * Single-channel file -> per-channel key. Old rows get channel '' (claimed
   * by claimLegacyLinks at start) and source = 0: the old file never said
   * which rows were Discord originals, and treating them as webhook copies
   * keeps hub edits/deletes of BBS messages working. The cost: deleting a
   * pre-upgrade Discord message in Discord no longer deletes its hub copy.
   */
  private migrateToPerChannel(): void {
    this.db.transaction(() => {
      this.db.exec('ALTER TABLE message_map RENAME TO message_map_v1; DROP INDEX IF EXISTS message_map_created;');
      this.db.exec(MESSAGE_MAP_DDL);
      this.db.exec(`
        INSERT INTO message_map(hub_message_id, channel_id, discord_message_id, room_id, created_at, author_label, content, source)
          SELECT hub_message_id, '', discord_message_id, room_id, created_at, author_label, content, 0 FROM message_map_v1;
        DROP TABLE message_map_v1;
      `);
    })();
  }

  /**
   * Give rows from before multi-guild (channel '') the channel their room was
   * linked to then: the first channel listed for the room. Returns how many.
   */
  claimLegacyLinks(firstChannelOf: (roomId: string) => string | undefined): number {
    const rooms = this.db.prepare("SELECT DISTINCT room_id FROM message_map WHERE channel_id = ''").all() as { room_id: string }[];
    let n = 0;
    for (const { room_id: room } of rooms) {
      const ch = firstChannelOf(room);
      if (ch) n += this.db.prepare("UPDATE OR IGNORE message_map SET channel_id = ? WHERE channel_id = '' AND room_id = ?").run(ch, room).changes;
    }
    return n;
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
      .prepare('INSERT OR REPLACE INTO message_map(hub_message_id, channel_id, discord_message_id, room_id, created_at, author_label, content, source) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(link.hubMessageId, link.channelId ?? '', link.discordMessageId, link.roomId, link.createdAt, link.authorLabel ?? '', link.content ?? '', link.source ? 1 : 0);
  }

  /** New text for every twin of the hub message. */
  setContent(hubMessageId: string, content: string): void {
    this.db.prepare('UPDATE message_map SET content = ? WHERE hub_message_id = ?').run(content, hubMessageId);
  }

  /** Store the text of the webhook copies only; the source row keeps what the hub holds. */
  setCopyContent(hubMessageId: string, content: string): void {
    this.db.prepare('UPDATE message_map SET content = ? WHERE hub_message_id = ? AND source = 0').run(content, hubMessageId);
  }

  /** Drop every twin of the hub message. */
  removeByHub(hubMessageId: string): void {
    this.db.prepare('DELETE FROM message_map WHERE hub_message_id = ?').run(hubMessageId);
  }

  /** Drop one twin. */
  removeByDiscord(discordMessageId: string): void {
    this.db.prepare('DELETE FROM message_map WHERE discord_message_id = ?').run(discordMessageId);
  }

  private fromRow(r: Row | undefined): MessageLink | undefined {
    return r && {
      hubMessageId: r.hub_message_id, discordMessageId: r.discord_message_id, roomId: r.room_id, channelId: r.channel_id,
      source: r.source === 1, createdAt: r.created_at, authorLabel: r.author_label, content: r.content,
    };
  }

  /** The first twin of the hub message; byHubIn for one channel. */
  byHub(hubMessageId: string): MessageLink | undefined {
    return this.fromRow(this.db.prepare('SELECT * FROM message_map WHERE hub_message_id = ? ORDER BY rowid LIMIT 1').get(hubMessageId) as Row | undefined);
  }

  /** The twin of the hub message in one Discord channel. */
  byHubIn(hubMessageId: string, channelId: string): MessageLink | undefined {
    return this.fromRow(this.db.prepare('SELECT * FROM message_map WHERE hub_message_id = ? AND channel_id = ?').get(hubMessageId, channelId) as Row | undefined);
  }

  /** Every twin of the hub message, one per channel, oldest first. */
  linksOf(hubMessageId: string): MessageLink[] {
    return (this.db.prepare('SELECT * FROM message_map WHERE hub_message_id = ? ORDER BY rowid').all(hubMessageId) as Row[]).map((r) => this.fromRow(r) as MessageLink);
  }

  byDiscord(discordMessageId: string): MessageLink | undefined {
    return this.fromRow(this.db.prepare('SELECT * FROM message_map WHERE discord_message_id = ?').get(discordMessageId) as Row | undefined);
  }

  /** Drop links created before `cutoff` (epoch ms); returns how many. */
  pruneOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM message_map WHERE created_at < ?').run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }
}
