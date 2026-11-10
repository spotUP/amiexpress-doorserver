---
date: 2026-09-03
topic: SP1 - the achievements API, rule engine and storage on the door server
tags: [achievements, doorserver, sqlite, rule-engine, contract, 68k, seasons, leaderboard, smtp, reachability]
status: draft
---

# SP1 - the achievements surface on the door server

Umbrella spec: `amiexpress-web/docs/superpowers/specs/2026-09-03-global-achievements-design.md`
(committed `06b5efe01`). This plan implements its **SP1** only - the door
server's API, rule engine and storage. SP2 (the web BBS reporter), SP3 (the
TypeScript ACHIEVE door) and SP4 (the 68K client) are separate plans and are
named here only where they consume something this plan produces.

Repository: `amiexpress-doorserver` (its own git repo). Every `file:line`
below was opened against the working tree at `8bd0904` on 2026-09-03.
Prior art read before writing: `README.md`, `docs/DOOR-REPO-API.md`,
`docs/superpowers/specs/2026-08-23-door-server-split-design.md`,
`docs/superpowers/plans/2026-08-31-bulk-edit.md` (house style),
`~/.claude/REACHABILITY_PROTOCOL.md`, and `amiexpress-web/RULES.md`
(the sibling repo's rules; this repo has no `RULES.md` - its `README.md`
"Commands" table is the equivalent, and this plan does not invent one).

Paths are repo-relative and shortened after first mention:

| short name | full path |
|---|---|
| `app.ts`, `config.ts`, `auth.ts`, `db.ts`, `migrations.ts`, `index.ts`, `routes.ts`, `manifest.ts`, `cors.ts`, `schema.sql` | `src/` |
| `ach/*` | `src/achievements/` (new directory - every file this plan creates lives here) |
| `contract/achievement-types.ts` | new, beside `contract/manifest-types.ts` |
| `tests/ach/*` | `tests/achievements/` (new directory) |
| `ACHIEVEMENTS-API.md` | `docs/ACHIEVEMENTS-API.md` (new) |

New files, all cited short after first mention: `ach/config.ts`, `ach/db.ts`,
`ach/schema.sql`, `ach/migrations.ts`, `ach/boards.ts`, `ach/router.ts`,
`ach/mail.ts`, `ach/players.ts`, `ach/links.ts`, `ach/events.ts`,
`ach/counters.ts`, `ach/engine.ts`, `ach/catalog.ts`, `ach/doors.ts`,
`ach/profile.ts`, `ach/leaderboard.ts`, `ach/seasons.ts`, `ach/rarity.ts`,
`ach/ratelimit.ts`, `ach/text.ts`, `src/text-format.ts`,
`seeds/achievements.seed.json`, `scripts/achievements-board.ts`,
`scripts/achievements-season.ts`, `scripts/gen-achievement-types.ts`.

---

## Controller decisions (settled here - do not reopen mid-implementation)

These are the calls this plan makes where the umbrella spec was silent or
where its wording could not be implemented as written. Each carries its
reason. Three of them (D3, D8, D9) DIVERGE from a line in the spec's wire
table and are marked **[ESCALATE]**: implement as written here, and put the
divergence in front of the controller with this plan, not after the code.

**D1 - the board key carries its board id: `Authorization: Board <id>.<secret>`.**
`verifyPassword` (`auth.ts:67-87`) is a 50 ms scrypt by design. With an
opaque key the server would have to scrypt every board row on every request
- O(boards) x 50 ms on the hottest write path in the system. The key
therefore names its own row: `uprough.9f3c...` looks the row up by `id`, then
runs exactly one `verifyPassword` against `boards.key_hash`. The board id is
not a secret (it is already the prefix of every `ref`).

**D2 - a verified-key cache, invalidated by the row itself.** Even one 50 ms
scrypt per `POST /events` is 5 s of CPU per 100 flushes. `ach/boards.ts`
keeps an in-process `Map` from `sha256(presented key)` to
`{ boardId, keyHashAtVerify }`, TTL 5 minutes. On a hit the row is STILL read
(a single indexed SELECT) and the entry is honoured only while
`row.key_hash === keyHashAtVerify` and `row.suspended_at IS NULL` - so a
rotation or a suspension takes effect on the very next request, with no cache
flush to forget.

**D3 [ESCALATE] - a per-event verdict, not a whole-batch 400/403.** The
spec's status table reads `400` for "unknown event type" and `403` for
`not_linked`. A batch is up to 100 rows drained from an outbox that mixes
players and event types (spec, Component 2), so one unknown type or one
unlinked player would reject 99 good events, and the sender could not tell
WHICH row to drop. So: batch-level faults keep their codes (`400` for a body
that is not an array, over 100 entries, an event missing a required field, or
any `meta.*` type - that one is an attack signal, not a typo; `403` when
EVERY event in the batch is for an unlinked player, which is the single-player
case the 68K door always sends). Anything else answers `200` with a
`rejected: [{ref, reason}]` array and a top-level `not_linked: ["a@b.c"]`
list, so SP2's flusher can delete exactly the dead rows and arm the linking
notice for exactly the right addresses. `ACHIEVEMENTS-API.md` states that a
`rejected` entry is TERMINAL - never retried.

**D4 - `ACHIEVEMENTS_PLAIN_PORT` is not implemented.** The spec lists it as
config; the deployment section then says plain HTTP is delivered by Caddy's
redirect exemption, exactly as `/api/door-repo/*` already is
(`docs/DOOR-REPO-API.md:24-33`, measured live). The container publishes
`127.0.0.1:3010` only (`docker-compose.yml:12-13`); a second listener would
need another published port and another firewall hole and would still be
unreachable without the same Caddy change. One mechanism, not two. Settled
decision 8 ("plain-HTTP port for 68K callers") is satisfied by Caddy port 80.

**D5 - the same migration RUNNER, a separate migration ARRAY.** The spec says
"the existing forward-only `MIGRATIONS` array in `src/migrations.ts`". Run
literally, that array would try to `ALTER TABLE door_catalog` inside
`achievements.db`. `runMigrations(db, migrations)` (`migrations.ts:358-374`)
already takes the array as a parameter and creates `schema_migrations` in
whatever database it is handed, so the RUNNER is reused verbatim and
`ach/migrations.ts` owns a second array with its own version counter.

**D6 - `ACHIEVEMENTS_DB`'s directory must exist; the file need not.**
`mustExist` (`config.ts:38-43`) refuses a missing path, which is right for a
seeded catalog volume and wrong for a database that is born empty. The check
becomes `dirname(ACHIEVEMENTS_DB)` must exist; better-sqlite3 creates the
file and `ach/migrations.ts` fills it.

**D7 - unset `ACHIEVEMENTS_DB` disables the surface; set-but-no-SMTP is a
startup failure.** The spec wants a fail-loud refusal to mount without mail.
Both halves matter: a sysop who never configured achievements gets a server
that still serves the door repo (and logs one `[INFO]` line saying the
surface is off), and a sysop who DID configure it but forgot SMTP gets
`exit 1` with the variable named - never a half-mounted surface whose
`/players` endpoint takes an email address it can do nothing with. A silent
non-mount would reproduce the "a 404 means two different things" complaint
`docs/DOOR-REPO-API.md:53-92` already makes about the door repo.

**D8 [ESCALATE] - the definition digest covers name and description too.**
"An existing id's definition is IMMUTABLE" (settled decision 4). The digest
this plan hashes is `id + name + description + family + tier + points +
hidden + rule`, so renaming a published achievement is a `409` like any other
change. A mutable display name would need a policy for what a player who
unlocked "First Blood" sees when it becomes something else, and the door
repo's own precedent (an archive name is immutable because someone already
depends on it) points the same way.

**D9 [ESCALATE] - three server-internal `meta.*` types, not two.** The spec
appends `meta.link` and `meta.unlock`. `rare.newboard.first` ("the first
unlock ever recorded on a board") is expressible by no operator in the table
and would ship UNREACHABLE - the exact failure `~/.claude/REACHABILITY_PROTOCOL.md`
exists to stop. So the server also appends `meta.board_first` when it inserts
the first unlock for a board, and the achievement is a plain
`{op:"count", type:"meta.board_first", n:1}`. Boards still cannot post any
`meta.*` type. `presence.return30` needs no new machinery: it is a
board-computed fact under the spec's own pattern (`presence.call` with
`key="return:30"`), and `ACHIEVEMENTS-API.md` says so for SP2.

**D10 - `stat.snapshot` backs `count`, never `sum`.** A snapshot event's
`key` IS the counter type it snapshots (`{type:"stat.snapshot",
key:"file.upload", value:137}`), which is what makes
`ref=<board>:<email>:stat:<name>:<value>` idempotent. `count` over type T
compares against `max(counters.n, snapshots[T])`; `sum` reads incremental
events only. The five numbers `user.data` holds are all counts (spec, "out of
scope": historical backfill), and no byte total exists to snapshot.

**D11 - a `granted` sentinel operator for `rare.season.winner`.** Rules the
server grants directly carry `{"op":"granted"}`, which indexes under no event
type, so the engine never considers them and never accidentally awards one.

**D12 - no cron, no scheduler.** Season rolls and the nightly rarity
recompute are LAZY: `ensureCurrentSeason()` and `refreshRarityIfStale()` run
at the top of every write request and do nothing unless the clock says
otherwise (rarity at most once per 24 h, recorded in `meta`). Both are also
CLI entry points (`scripts/achievements-season.ts`) so a roll can be forced
and so tests can drive them at an arbitrary `now`. A scheduler inside the
container would be a second thing that can fail silently at 03:00.

**D13 - no CORS on `/achievements/v1`.** `cors.ts` exists because the door
repo is public, read-only and browser-consumable. This surface needs a board
key on every request; a board key must never be inside a browser. The absence
is deliberate and is written at the mount site.

**D14 - the "recorded week" is a committed, hand-audited stream, not a
production capture.** No board emits these events until SP2 ships, so there
is nothing to record. `tests/ach/fixtures/recorded-week.jsonl` is generated
once by a committed script, read line by line by a human, and then frozen -
including a future-stamped event and a 40-day-old one. The plan says so
rather than letting the word "recorded" imply provenance it does not have.

**D15 - rate limits are in-process and cover the write API only.** One
container, one process (`docker-compose.yml`), so a `Map` of fixed windows is
the whole implementation - no Redis, no second store. `GET /catalog`,
`/catalog.txt`, `/leaderboard*`, `/players/<email>` and `/health` are NOT
rate limited. This is the narrow exception the spec grants; no BBS-facing
path in either repo gains a limiter.

## Non-goals

- **Anything in SP2, SP3 or SP4.** No reporter, no outbox, no toast, no
  webhook, no door. This plan's only output for them is
  `contract/achievement-types.ts` and `ACHIEVEMENTS-API.md` (AC-3).
- **A web UI for achievements.** `web/` (the browser front end for the door
  catalog) is not touched. Board keys are issued by CLI and by the existing
  admin JWT surface; there is no achievements page.
- **Touching `doors.db`.** Not one column, not one row, not one migration.
  The only cross-database read is `requireAdmin` (`auth.ts:181-207`) looking
  up an admin account, and only on the board-issuing routes.
- **Changing any `/api/door-repo/*` response byte.** AC-12 MOVES three text
  helpers out of `manifest.ts`; `npm run test:parity` is the gate that proves
  `list.txt` did not shift, and it is a required manual step before deploy
  (`README.md`, "Commands").
- **Account merging, backfill, anti-cheat scoring, localisation** - the
  spec's own out-of-scope list, repeated so no task quietly grows one.

## Standing rules this plan must not break

- **The catalog database is untouched.** Every new table is in
  `achievements.db`. A test asserts `doors.db`'s table list is unchanged
  after a full achievements run (AC-2).
- **Regression test per change, RED before GREEN, named after the symptom.**
  Not "evaluates count rules" - "a player who posts a hundredth message
  unlocks Century, and posting the same message twice does not".
- **No emojis anywhere.** ASCII tokens (`[OK]`, `[ERROR]`, `[INFO]`) in log
  output, as `index.ts` already does.
- **Never `Edit`/`Write` a fixture with high-bit bytes.** The `.txt` variant
  fixtures are Latin-1 byte arrays built in code and compared with
  `Buffer.compare`, never written as UTF-8 source text.
- **`npm run typecheck` after every task**; `npm run test:ci` before any
  push; `npm run test:parity` before any deploy.
- **Commit hygiene:** never `git add -A`, never `--no-verify`, never amend,
  never `git stash`. `git diff --cached --stat` before every commit.
- **A green workflow lies.** AC-21's verification reads the live container's
  image age and the reported contract version, never the workflow's colour.

---

## Architecture in one paragraph

`createApp` (`app.ts:10-28`) mounts three door-repo routers and then the
static site; every path under `/api/door-repo` is claimed and the catch-all
at `app.ts:61` swallows everything else that is not `/api/`. This plan adds
ONE line at `app.ts:25` - `app.use('/achievements/v1',
createAchievementsRouter(ach))` - and everything else hangs off it inside
`src/achievements/`, against a SECOND database file opened by `ach/db.ts`
with the same `openDb`/`applySchema` shape `db.ts:13-20` already uses and the
same `runMigrations` runner. A request arrives with
`Authorization: Board <id>.<secret>`; `requireBoard` resolves the row, one
`verifyPassword` (`auth.ts:67-87`) proves the secret, and the board id - never
a field in the body - is what every write is attributed to. `POST /events`
validates the batch, clamps each `at` against the server's own clock, writes
`events` (PK `(board_id, ref)`, so a resend is a duplicate by construction)
and folds each accepted event into four materialised counter tables; the
engine then asks ONE indexed question - which achievements name a type this
batch touched - evaluates only those, inserts the new `unlocks`, appends its
own `meta.unlock` / `meta.board_first` events and re-enters, bounded at five
cascade levels. The catalog is data in the same database, seeded from
`seeds/achievements.seed.json` by an idempotent loader that never rewrites a
published id, extended by `PUT /catalog/doors/<door>` under the same
immutability rule, and served both as JSON and as the house `ACHIEVE|1|<rev>`
plain-text format built from the SAME three helpers `list.txt` uses - moved
out of `manifest.ts` into `src/text-format.ts` so there is one escaper, not
two.

| concern | survivor | why not a second one |
|---|---|---|
| password/key hashing | `hashPassword`/`verifyPassword` (`auth.ts:52-87`) | a second KDF is a second native-free promise to keep; the spec names these explicitly |
| migration running | `runMigrations` (`migrations.ts:358-374`) | already parameterised by the array (D5) |
| Latin-1 / CRLF / `\|`-escaping | `src/text-format.ts` (moved from `manifest.ts:349-377`) | `list.txt` and `catalog.txt` must escape identically or two 68K parsers diverge |
| contract mirror rendering | `renderMirror` (`scripts/gen-contract-types.ts:13-24`) | one generator, two contract files |
| "what revision is this" | `a<count>-t<max(updated_at)>` | same fingerprint shape as `getCatalogRevision`, never a git SHA |
| admin identity | `requireAdmin` (`auth.ts:181-207`) | board issuing is curation; curation already has an auth story |

---

## Task AC-1 - RED: eleven symptoms, named the way a board author would name them

**No production code.** One new file `tests/achievements/symptoms.test.ts`.
Every test drives `createApp(cfg)` through supertest, exactly as
`tests/routes.test.ts:44-52` does - never a router or a function in
isolation. All eleven fail on arrival; each is moved (not copied) into its
owning task's suite as that task turns it GREEN, and AC-20's ledger records
which task closed which.

```ts
// tests/achievements/symptoms.test.ts
import request from 'supertest';
import { createApp } from '../../src/app';
import { makeAchievementsFixture } from './helpers';   // AC-2 creates this

describe('the achievements surface, as a board author meets it', () => {
  it('SYM-1: a board with a valid key is told 404 by a server that never mounted the surface', ...);
  it('SYM-2: a board with an unknown key can still read the catalog', ...);       // must be 401
  it('SYM-3: a suspended board keeps reporting events', ...);                     // must be 403
  it('SYM-4: registering twice creates two players for one email', ...);
  it('SYM-5: a board reports for an email that never linked it and the events land', ...);
  it('SYM-6: the same ref sent twice counts twice', ...);
  it('SYM-7: an event stamped next year sets a streak nobody earned', ...);
  it('SYM-8: a board posts meta.unlock and mints itself an achievement', ...);
  it('SYM-9: catalog.txt comes back as UTF-8 with LF line endings', ...);
  it('SYM-10: a door redefines a published achievement id and the old definition is lost', ...);
  it('SYM-11: a private player appears in the global leaderboard', ...);
});
```

**Automated verification.**
`npx jest --config jest.config.ts tests/achievements/symptoms.test.ts`
- expect 11 failures, 0 passes. A test that PASSES here is mis-specified and
is rewritten before AC-2 starts (Gate 2).

**Success criteria.** Eleven named failures, each naming a user-visible
symptom, and the file compiles under `npm run typecheck`.

---

## Task AC-2 - the second database: config, open, schema, migrations

The storage bones. Nothing is mounted yet; nothing answers HTTP.

**`ach/config.ts`** (new) - read through `loadConfig()` and shaped like
`config.ts:30-43`:

```ts
export interface AchievementsConfig {
  dbPath: string;          // ACHIEVEMENTS_DB
  smtpUrl: string;         // ACHIEVEMENTS_SMTP_URL
  mailFrom: string;        // ACHIEVEMENTS_MAIL_FROM
  publicBaseUrl: string;   // ACHIEVEMENTS_BASE_URL, for the mail body only
}

/**
 * Unset ACHIEVEMENTS_DB disables the surface entirely (null); the door repo
 * is unaffected and index.ts logs one [INFO] line. Set-but-incomplete is a
 * ConfigError and the process exits: a /players endpoint that takes an email
 * address and cannot send a code is worse than one that is absent, because
 * the player has already given their address. See D6/D7.
 */
export function loadAchievementsConfig(env = process.env): AchievementsConfig | null;
```

`dbPath`'s DIRECTORY is checked with the existing `mustExist` idea (D6); the
file itself is created on first open.

**`config.ts` edit** - one field on `ServerConfig` (`config.ts:18-26`) and one
line in `loadConfig` (`config.ts:60-71`):

```ts
export interface ServerConfig {
  ...
  learnKey: string | null;
  achievements: AchievementsConfig | null;   // null = surface not mounted
}
```

Every existing test constructs `ServerConfig` as an object literal
(`tests/routes.test.ts:25`, `tests/migrations.test.ts:18`, and 9 more) and so
must gain `achievements: null`. That is a mechanical edit across
`tests/*.test.ts`; the type checker names every site.

**`ach/schema.sql`** (new) - the full table set. Given in one block so nothing
is invented later:

```sql
CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,             -- 'uprough'; also the ref prefix
  name         TEXT NOT NULL,
  contact      TEXT,
  key_hash     TEXT NOT NULL,                -- scrypt$..., src/auth.ts
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  suspended_at INTEGER
);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_key   TEXT NOT NULL UNIQUE,          -- lower(trim(email)); the identity
  email       TEXT NOT NULL,                 -- as given, for the mail envelope
  handle      TEXT NOT NULL,
  verified_at INTEGER,
  private     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_handle ON players(handle COLLATE NOCASE);

-- One live code per kind per player. A new code REPLACES the old one, which
-- is what makes "resend" and "rotate" the same operation.
CREATE TABLE IF NOT EXISTS player_codes (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify','link')),
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (player_id, kind)
);

CREATE TABLE IF NOT EXISTS links (
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (board_id, player_id)
);

-- Append-only. The PK is the idempotency rule: a resent ref is a duplicate
-- by construction, not by a lookup somebody might forget to write.
CREATE TABLE IF NOT EXISTS events (
  board_id    TEXT NOT NULL,
  ref         TEXT NOT NULL,
  player_id   INTEGER NOT NULL,
  type        TEXT NOT NULL,
  key         TEXT,
  value       REAL NOT NULL DEFAULT 1,
  at          INTEGER NOT NULL,              -- CLAMPED, UTC epoch seconds
  received_at INTEGER NOT NULL,
  clamped     INTEGER NOT NULL DEFAULT 0,
  door        TEXT,
  client      TEXT,
  PRIMARY KEY (board_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_events_player_type_at ON events(player_id, type, at);

-- count / sum / first. Every event writes BOTH the keyless row (key = '')
-- and its keyed row, so a keyless rule never has to sum across keys.
CREATE TABLE IF NOT EXISTS counters (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  key       TEXT NOT NULL DEFAULT '',
  n         INTEGER NOT NULL DEFAULT 0,
  sum_value REAL NOT NULL DEFAULT 0,
  first_at  INTEGER,
  last_at   INTEGER,
  PRIMARY KEY (player_id, type, key)
);

-- distinct. grp = '' is the ungrouped row; grp = <event key> is the
-- key-grouped row, which is the only grouping the spec's rules use.
CREATE TABLE IF NOT EXISTS counter_dims (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  dim       TEXT NOT NULL,                   -- 'key' | 'board'
  grp       TEXT NOT NULL DEFAULT '',
  dim_value TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, type, dim, grp, dim_value)
);

-- streak. UTC calendar days, from the CLAMPED timestamp.
CREATE TABLE IF NOT EXISTS counter_days (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  day       TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  PRIMARY KEY (player_id, type, day)
);

-- stat.snapshot, stored as max(existing, value). name = the counter type.
CREATE TABLE IF NOT EXISTS snapshots (
  player_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  value      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, name)
);

CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  family      TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('bronze','silver','gold','platinum')),
  points      INTEGER NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  rule        TEXT NOT NULL,                 -- JSON, the operator
  digest      TEXT NOT NULL,                 -- sha256 over the definition (D8)
  source      TEXT NOT NULL,                 -- 'seed' | 'door:<command>'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The candidate index: which achievements can a given event type possibly
-- move. Without it every event scans the whole catalog.
CREATE TABLE IF NOT EXISTS achievement_types (
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  PRIMARY KEY (achievement_id, type)
);
CREATE INDEX IF NOT EXISTS idx_achievement_types_type ON achievement_types(type);

CREATE TABLE IF NOT EXISTS unlocks (
  player_id      INTEGER NOT NULL,
  achievement_id TEXT NOT NULL,
  board_id       TEXT NOT NULL,              -- where it happened; never NULL
  season_id      TEXT NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (player_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_unlocks_ach ON unlocks(achievement_id);
CREATE INDEX IF NOT EXISTS idx_unlocks_board ON unlocks(board_id);
CREATE INDEX IF NOT EXISTS idx_unlocks_season ON unlocks(season_id);

CREATE TABLE IF NOT EXISTS seasons (
  id        TEXT PRIMARY KEY,                -- '2026Q3'
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS rarity (
  achievement_id TEXT PRIMARY KEY,
  unlocked       INTEGER NOT NULL,
  verified       INTEGER NOT NULL,
  pct_tenths     INTEGER NOT NULL,           -- 81 = 8.1%; integers for C89
  bucket         TEXT NOT NULL,
  computed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  sent_at    INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_due ON mail_queue(sent_at, next_at);

CREATE TABLE IF NOT EXISTS door_catalog_digests (
  door       TEXT PRIMARY KEY,
  digest     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT,
  action   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_board_audit_at ON board_audit(at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
```

**`ach/db.ts`** (new) - the only place that opens `achievements.db`, mirroring
`db.ts:13-20`:

```ts
export function openAchievementsDb(ach: AchievementsConfig, opts?: { readonly?: boolean }): Database.Database;
export function applyAchievementsSchema(db: Database.Database): void; // reads ach/schema.sql beside __dirname
export function initAchievementsDb(ach: AchievementsConfig): string[]; // schema + runMigrations, returns what ran
```

**`ach/migrations.ts`** (new) - `export const ACHIEVEMENTS_MIGRATIONS: Migration[] = []`,
importing the `Migration` type and `hasColumn` from `migrations.ts:15-25`.
Empty at birth and that is correct: `schema.sql` creates a database that does
not exist yet, and the first entry is added the first time a column is added
after the first deploy. A test asserts the array's versions are unique and
ascending so the second one cannot collide with the first.

**`index.ts` edit** (`index.ts:49-65`, inside the existing migrate block, after
the door-repo migrations and before `bootstrapAdmins`):

```ts
if (cfg.achievements) {
  for (const step of initAchievementsDb(cfg.achievements)) {
    console.log(`[INFO] achievements migration ${step}`);
  }
} else {
  console.log('[INFO] achievements surface disabled: ACHIEVEMENTS_DB is not set');
}
```

**`package.json` edit** - the `build` script (`package.json:7`) copies
`src/schema.sql` by hand because `tsc` does not emit `.sql`. The new schema
needs the same treatment or the container starts and dies on `readFileSync`
- the exact `lha.js` failure the Dockerfile comments about at
`Dockerfile:49-54`:

```
"build": "tsc -p tsconfig.json && cp src/schema.sql dist/src/schema.sql && mkdir -p dist/src/achievements && cp src/achievements/schema.sql dist/src/achievements/schema.sql && cp src/lha.js dist/src/lha.js && mkdir -p dist/seeds && (cp seeds/*.json dist/seeds/ 2>/dev/null || true)"
```

**`tests/achievements/helpers.ts`** (new) - `makeAchievementsFixture()`
returns `{ dir, cfg, app, db }` with a temp directory, an initialised
`achievements.db`, a one-door `doors.db` (copied from
`tests/routes.test.ts:20-38`, not re-invented) and a recording mailer. Every
achievements suite uses it.

**RED -> GREEN tests** (`tests/achievements/storage.test.ts`):
- `a server with no ACHIEVEMENTS_DB still serves the door catalog` (the
  disabled path does not break startup)
- `a set ACHIEVEMENTS_DB whose directory does not exist refuses to start, naming the variable`
- `ACHIEVEMENTS_DB without ACHIEVEMENTS_SMTP_URL refuses to start, naming the variable`
- `initialising the achievements database leaves the door catalog's tables untouched`
  (snapshot `sqlite_master` of `doors.db` before and after; this is SP1's
  whole reason for a second file)
- `running startup twice applies no migration the second time`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/storage.test.ts
npx jest --config jest.config.ts tests/config.test.ts tests/migrations.test.ts tests/startup.test.ts
npm run build && test -f dist/src/achievements/schema.sql
```

**Success criteria.** Five green; the whole existing suite still green after
the `ServerConfig` field lands; `dist/src/achievements/schema.sql` exists
after a build.

---

## Task AC-3 - THE CONTRACT (lands first after the bones; SP2 and SP4 block on it)

Two artefacts, one machine-readable and one human-readable. **Nothing in SP2
or SP4 can start until this task is committed**, which is why it comes third
and not last. It describes endpoints that do not exist yet - that is the
point; the shapes are frozen from the spec, and every later task in this plan
is checked AGAINST this file rather than the file being edited to match the
code.

### `contract/achievement-types.ts` (new, beside `contract/manifest-types.ts`)

```ts
/**
 * The achievements wire contract: the shapes every client compiles against.
 * Clients vendor a generated mirror (scripts/gen-achievement-types.ts);
 * ACHIEVEMENTS_CONTRACT_VERSION tells a client whether its mirror is old
 * enough to matter. Echoed on every response as X-Achievements-Contract.
 */
export const ACHIEVEMENTS_CONTRACT_VERSION = '1';

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type RarityBucket = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type Rule =
  | { op: 'count';    type: string; key?: string; n: number }
  | { op: 'first';    type: string; key?: string }
  | { op: 'sum';      type: string; field: 'value'; n: number }
  | { op: 'distinct'; type: string; dim: 'key' | 'board'; n: number; group?: 'key' }
  | { op: 'streak';   type: string; unit: 'day'; n: number }
  | { op: 'within';   type: string; n: number; window_s: number }
  | { op: 'all';      ids: string[] }
  | { op: 'granted' };                       // server-granted only (D11)

export interface AchievementDef {
  id: string; name: string; description: string; family: string;
  tier: Tier; points: number; hidden: boolean; rule: Rule;
}

export interface CatalogAchievement extends AchievementDef {
  rarityPctTenths: number;                   // 81 = 8.1% (integers for C89)
  rarityBucket: RarityBucket;
  updatedAt: string;                         // ISO 8601, UTC
}

export interface CatalogResponse {
  contractVersion: string; revision: string; since: string | null;
  achievements: CatalogAchievement[];
}

export interface EventIn {
  ref: string; email: string; type: string; at: string;
  value?: number; key?: string | null; door?: string | null; client?: string | null;
}

export interface UnlockOut {
  id: string; name: string; tier: Tier; points: number;
  hidden: boolean; rarityPctTenths: number; at: string;
}

export interface ProgressOut { id: string; have: number; need: number }
export interface RejectedEvent { ref: string; reason: RejectReason }
export type RejectReason = 'unknown_event_type' | 'not_linked' | 'unknown_player' | 'unverified_player';

export interface EventsResponse {
  accepted: number; duplicates: number;
  rejected: RejectedEvent[];                 // TERMINAL - never retried (D3)
  notLinked: string[];                       // emails whose board link is missing
  unlocks: UnlockOut[]; progress: ProgressOut[];
}

export interface PlayerProfile {
  handle: string; verified: boolean; private: boolean;
  points: number; linkedBoards: string[];
  unlocks: UnlockOut[]; progress: ProgressOut[];
  linkCode?: string; linkCodeExpiresAt?: string;  // only on verify / rotate
}

export interface LeaderboardRow { rank: number; handle: string; points: number; unlocks: number }
export interface LeaderboardResponse {
  scope: string; period: 'all' | 'season'; season: string | null;
  revision: string; rows: LeaderboardRow[];
}

export interface ApiError { error: string; detail?: string; retryAfter?: number }
```

### `scripts/gen-achievement-types.ts` (new)

Nine lines: import `renderMirror` from `scripts/gen-contract-types.ts:13-24`
and point it at the new source. One generator, two contract files.

### `tests/achievements/contract.test.ts` (new)

Shaped on `tests/contract-mirror.test.ts`: the version is declared, the
mirror renders, the mirror carries no `import` line, and - the addition -
**every status code and field name in `ACHIEVEMENTS-API.md` appears in the
contract module**, so the prose and the types cannot drift apart silently.

### `docs/ACHIEVEMENTS-API.md` (new) - the document SP2 and SP4 code against

Written to the standard of `docs/DOOR-REPO-API.md`: every endpoint, every
request field, every response field, every status code, and a worked example
per endpoint. Its required sections:

1. **Base URLs and transports.** `https://doors.uprough.net/achievements/v1`
   and the same paths on plain HTTP (Caddy exemption, AC-21). The board key
   travels in clear on the plain path - stated, with the spec's risk 5
   mitigations.
2. **Authentication.** `Authorization: Board <board-id>.<secret>` (D1). `401`
   unknown/missing, `403` suspended. How a board gets a key: AC-4's CLI, or
   the three admin-token routes under `/achievements/v1/admin/boards`, which
   are documented in their own short section because they are curation, not
   a board-facing API.
3. **Headers on every response.** `X-Achievements-Contract`,
   `X-Achievements-Revision`, `Content-Type: application/json; charset=utf-8`
   or `text/plain; charset=ISO-8859-1` for the `.txt` variants.
4. **Endpoint by endpoint**, in this order, each with request JSON, response
   JSON, and the full status list:
   `POST /players`, `POST /players/verify`, `POST /players/resend`,
   `POST /links`, `DELETE /links`, `POST /links/rotate`,
   `POST /events`, `GET /catalog`, `GET /catalog.txt`,
   `PUT /catalog/doors/<door>`, `GET /leaderboard`, `GET /leaderboard.txt`,
   `GET /players/<email>`, `PATCH /players/<email>` (the private flag),
   `GET /health`.
5. **The event contract.** One `key` per event; a two-dimensional fact is two
   events with two refs. `ref` formats. The `meta.*` prohibition. The clamp
   window (15 min future / 30 days past) and that streaks are UTC calendar
   days. The **board-computed facts table**, naming the key each one carries,
   because SP2 implements exactly that table:
   `msg.post key="conf:<id>"` / `key="lines:100+"`, `msg.reply key="fast"`,
   `file.download key="age:25y+"`, `file.ratio key="silver"|"gold"`,
   `presence.call key="hour:NN"` / `key="caller:1000"` / `key="return:30"`,
   `wall.tag key="conf:<id>"`, `bull.read.all`, `stat.snapshot key=<type>`.
6. **What is TERMINAL and what is RETRYABLE** (D3): `4xx` and any `rejected`
   entry are terminal - the sender deletes the row; `5xx`, a timeout and a
   `429` are retryable with the spec's backoff.
7. **The plain-text formats**, byte for byte, with a real example and the
   append-only promise, in the same words `docs/DOOR-REPO-API.md` uses for
   `list.txt`.
8. **Versioning.** What a contract bump means, and what a client that reads a
   field it does not know must do (ignore it).

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/contract.test.ts
npx tsx scripts/gen-achievement-types.ts /tmp/mirror.ts && head -5 /tmp/mirror.ts
```
**Manual (the controller's).** Read `ACHIEVEMENTS-API.md` end to end and
confirm the three `[ESCALATE]` decisions (D3, D8, D9) before SP2 starts.

**Success criteria.** Both files committed; the contract test green; the doc
covers all fifteen endpoints with a worked example each; SP2 and SP4 are
unblocked and told so.

---

## Task AC-4 - boards: rows, key hashing, `Board <id>.<secret>`, 401 / 403, audit

**`ach/boards.ts`** (new):

```ts
const BOARD_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Mint a board. Returns the ONE-TIME plaintext key; only the hash is stored. */
export function createBoard(db, id: string, name: string, contact: string | null):
  { id: string; key: string };   // key = `${id}.${crypto.randomBytes(24).toString('base64url')}`

export function rotateBoardKey(db, id: string): { key: string };
export function setBoardSuspended(db, id: string, suspended: boolean): void;

export interface BoardRequest extends Request { board?: { id: string; name: string } }

/**
 * Gate for every /achievements/v1 route. 401 for a missing, malformed or
 * wrong key; 403 for a suspended board. The board id rides in the key (D1)
 * so exactly one scrypt runs per request, and a 5-minute verified-key cache
 * (D2) keeps the write path off the 50 ms path - the cache is honoured only
 * while the row's key_hash is unchanged and suspended_at is still NULL, so a
 * rotation or suspension bites on the next request with nothing to flush.
 */
export function requireBoard(ach: AchievementsConfig) { ... }

/** `<board-id> <action> <count>` on every accepted write (spec, Component 1). */
export function auditBoard(db, boardId: string, action: string, count: number): void;
```

Constant-time comparison is `verifyPassword`'s `timingSafeEqual`
(`auth.ts:86`) - no second comparison is written.

**`scripts/achievements-board.ts`** (new) - the CLI that mints the first key
before any UI exists, in the style of `scripts/db-stats.ts`:

```
npx tsx scripts/achievements-board.ts list
npx tsx scripts/achievements-board.ts create <id> "<name>" [contact]
npx tsx scripts/achievements-board.ts rotate <id>
npx tsx scripts/achievements-board.ts suspend <id> | resume <id>
```
`create` and `rotate` print the plaintext key ONCE with a `[WARN] this is the
only time this key is shown` line.

**Board issuing over HTTP** - three routes on the achievements router, gated
by `requireAdmin(cfg)` (`auth.ts:181-207`) rather than by a board key, because
issuing a key is curation and curation already has an auth story:
`GET /achievements/v1/admin/boards`, `POST /achievements/v1/admin/boards`,
`POST /achievements/v1/admin/boards/:id/(rotate|suspend|resume)`. They read
`admin_users` out of `doors.db` and write `boards` in `achievements.db`; that
is the only cross-database access in this plan and it is auth-only.

**RED -> GREEN tests** (`tests/achievements/boards.test.ts`), all through
`createApp`:
- `a request with no Authorization header is refused with 401, not served`
- `a key naming an unknown board is refused with 401 and does not say which half was wrong`
- `a key with the right board id and a wrong secret is refused with 401`
- `a suspended board's events are refused with 403 while its reads still work`
- `rotating a key stops the old key on the very next request` (the cache test - D2)
- `a board id that is not lowercase-slug shaped is refused at creation`
- `every accepted write appends one board_audit row naming the board and the count`
- `creating a board twice with the same id fails and does not change the stored hash`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/boards.test.ts
npx tsx scripts/achievements-board.ts create testboard "Test" </dev/null   # against a temp DB
```

**Success criteria.** Eight green; SYM-2 and SYM-3 from AC-1 move here and
pass; no route anywhere under `/achievements/v1` answers without either a
board key or an admin token.

---

## Task AC-5 - the mount, the health object, the contract header

**`app.ts` edit** - ONE line, at `app.ts:25`, between the door-repo routers
and `mountWebUi(app)` (`app.ts:26`), because `mountWebUi`'s catch-all
(`app.ts:61`, `/^(?!\/api\/).*/`) would otherwise swallow every achievements
path and answer `index.html`:

`createApp` gains ONE optional parameter -
`createApp(cfg, opts?: { mailer?: Mailer })` - so a test injects a recording
mailer and no suite ever opens an SMTP socket. Every existing call site
(`index.ts:80`, eleven test files) is unchanged: the parameter is optional
and defaults to `smtpMailer(cfg.achievements)`.

```ts
  app.use('/api/door-repo', createRouter(cfg));
  // The achievements surface: a sibling API, not a door-repo route. Mounted
  // BEFORE mountWebUi because its catch-all only exempts /api/. No CORS
  // middleware in front of it, deliberately: every request here carries a
  // board key, and a board key must never be inside a browser (see cors.ts
  // for why the door repo is the opposite case).
  if (cfg.achievements) {
    app.use('/achievements/v1', createAchievementsRouter(cfg, cfg.achievements, opts?.mailer ?? smtpMailer(cfg.achievements)));
  }
  mountWebUi(app);
```

**`ach/router.ts`** (new) - the router skeleton:
- `express.json({ limit: '256kb' })` (a 100-event batch is ~20 KB; the limit
  matches `admin-routes.ts:187`)
- one middleware setting `X-Achievements-Contract` (the contract version)
  and `X-Achievements-Revision` (the CATALOG revision, on every response
  including errors, so a client can notice a catalog change without asking)
  the way `X-Door-Repo-Revision` is set at `routes.ts:506`
- `requireBoard` in front of everything except `/health` and `/admin/*`
- `GET /health` -> `{ status, contractVersion, revision, players, boards, pendingMail, season }`

**`routes.ts` edit** (`routes.ts:503-508`) - the door-repo health gains the
same object, because that is the URL the container healthcheck
(`docker-compose.yml:33`) and the deploy workflow already call:

```ts
    res.json({ status: 'ok', revision, doors, achievements: achievementsHealth(cfg) });
```
`achievementsHealth` returns `{ enabled: false }` when the surface is off, so
the healthcheck cannot start failing on a server that never wanted it.

**RED -> GREEN tests** (`tests/achievements/mount.test.ts`):
- `the achievements surface answers on /achievements/v1, not under /api/door-repo`
- `an achievements path does not fall through to the single-page app's index.html`
  (this is the one that would only show up in a browser)
- `every response carries the contract version header`
- `the door-repo health object gains achievements without changing its existing fields`
- `a server with achievements disabled reports enabled:false and still passes the container healthcheck`
- `no achievements response carries an Access-Control-Allow-Origin header` (D13)

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/mount.test.ts tests/routes.test.ts tests/web-ui.test.ts tests/cors.test.ts
```

**Success criteria.** Six green; `tests/web-ui.test.ts` and `tests/cors.test.ts`
pass UNEDITED (the mount must not disturb either); SYM-1 moves here.

---

## Task AC-6 - mail: the SMTP seam, the queue, the drain, the pending count

A registration endpoint that cannot send a code is the spec's stated
worst case, so mail is built BEFORE the endpoint that needs it.

**Dependency.** `nodemailer` (pure JavaScript - no native addon, which is
what matters here: `Dockerfile:13-14` compiles native code from source
against musl and `auth.ts:1-9` records why a second compiled dependency is
not wanted). `@types/nodemailer` as a dev dependency. Both pinned to the
exact version `npm install` resolves, recorded in the commit message.

**`ach/mail.ts`** (new):

```ts
export interface Mailer { send(to: string, subject: string, body: string): Promise<void> }

/** The real one: nodemailer over ACHIEVEMENTS_SMTP_URL. */
export function smtpMailer(ach: AchievementsConfig): Mailer;

/** Queue, never send inline: the HTTP response must not wait on an SMTP
 *  handshake, and a registration must survive the mail server being down. */
export function queueMail(db, to: string, subject: string, body: string): void;

/** Drain: up to 20 due rows, backoff 60 s / 5 min / 30 min / 2 h / 6 h, and a
 *  row still unsent after 3 days is marked failed and logged - the same
 *  reasoning as SP2's 14-day outbox rule, shorter because a verification code
 *  has expired long before then anyway. */
export function drainMailQueue(db, mailer: Mailer, now: number): Promise<{ sent: number; failed: number }>;

export function pendingMailCount(db): number;
```

**`index.ts` edit** (after `app.listen`, `index.ts:81-84`), the only timer
this plan starts:

```ts
  if (cfg.achievements) {
    const ach = cfg.achievements;
    const mailer = smtpMailer(ach);
    setInterval(() => {
      const db = openAchievementsDb(ach);
      drainMailQueue(db, mailer, Date.now() / 1000)
        .then(({ sent, failed }) => { if (sent || failed) console.log(`[INFO] mail drain sent ${sent} failed ${failed}`); })
        .catch((err) => console.error(`[ERROR] mail drain: ${(err as Error).message}`))
        .finally(() => db.close());
    }, 30_000).unref();      // unref: a test that imports index.ts must still exit
  }
```

Tests never touch that timer: they call `drainMailQueue` directly with an
injected clock and the recording mailer `createApp`'s `opts` supplies, so no
suite opens a socket and no suite waits 30 seconds.

**Mail body.** Plain text, ASCII only (a verification code has to be typed on
an Amiga keyboard), the code on its own line, the board's name absent - the
mail comes from the achievement service, not from a board.

**RED -> GREEN tests** (`tests/achievements/mail.test.ts`):
- `a registration whose SMTP server is refusing connections still returns 202 and keeps the code`
- `a queued mail that fails is retried on the schedule and not on every drain`
- `a mail still unsent after three days is marked failed, logged, and stops being retried`
- `the health object's pendingMail count matches the queue`
- `the verification mail body is pure ASCII and carries the code on its own line`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/mail.test.ts
node -e "require('nodemailer'); console.log('[OK] nodemailer loads')"
```

**Success criteria.** Five green; no test in the repo opens an SMTP socket;
`npm ci` in a clean checkout still builds the Docker image (AC-21 re-checks).

---

## Task AC-7 - players: register, verify, resend

**`ach/players.ts`** (new).

Codes: six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 symbols, no
`0/O/1/I/L` - they are typed off a screen on a real Amiga). 31^6 is 8.9e8,
which is only safe with an attempt cap, so: **5 wrong attempts burns the
code**, verification codes live 30 minutes, link codes 15 (the spec's
number). Codes are stored as `hashPassword(code)` and checked with
`verifyPassword` - one scrypt per attempt, which is also the rate limiter of
last resort on guessing. The lookup is by email, so there is never more than
one hash to compute.

```
POST /players           { email, handle }        -> 202 { queued: true }
POST /players/verify    { email, code }          -> 200 PlayerProfile (with linkCode)
POST /players/resend    { email }                -> 202 { queued: true }
```

Rules, each of which is a test below:
- `email_key = lower(trim(email))` is the identity. A second registration of
  an EXISTING email never creates a second player: it re-queues a code to the
  same address and changes nothing else (spec, "Identity, trust and linking").
- A registration that supplies a DIFFERENT handle for an existing verified
  email is accepted and ignored - the handle is not changed by a
  re-registration, because anyone who knows the address could otherwise
  rename the player. A verified player renames through
  `PATCH /players/<email>` from a linked board (AC-14).
- Handles are unique case-insensitively, 3-16 characters,
  `^[A-Za-z0-9][A-Za-z0-9 ._-]{2,15}$`, and a taken handle is `409
  handle_taken` at registration - the door can then ask for another.
- The email is validated shallowly (one `@`, a dot in the domain, <= 254
  characters). Deep validation is the mail server's job and the code is the
  real proof.
- `202` always for `POST /players`, whether or not the address exists - the
  response never reveals whether an email is registered.

**RED -> GREEN tests** (`tests/achievements/players.test.ts`):
- `registering the same email twice leaves one player and sends a second code` (SYM-4)
- `a re-registration cannot rename an existing player`
- `an expired verification code is refused and the player stays unverified`
- `a verification code stops working after five wrong attempts`
- `a used verification code cannot be used a second time`
- `verifying returns the profile and a link code, and never returns the email`
- `a handle already taken by another player is refused with 409 at registration`
- `registering an address that already exists answers 202 without saying so`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/players.test.ts
```

**Success criteria.** Eight green; SYM-4 moves here; no response body anywhere
in the suite contains an `@`.

---

## Task AC-8 - links: link, unlink, rotate, and `meta.link`

**`ach/links.ts`** (new).

```
POST   /links         { email, code }   -> 200 { linked: true, boards: [...] }
DELETE /links         { email }         -> 200 { linked: false, boards: [...] }
POST   /links/rotate  { email, code }   -> 200 { linkCode, linkCodeExpiresAt }
```

- The link code is single-use: a successful `POST /links` marks it used and
  issues a fresh one in the same response, so a player linking three boards
  types three different codes and a captured code is worthless after one use
  (spec, risk 5).
- `POST /links` links the KEY's board. There is no board field in the body,
  ever.
- `DELETE /links` unlinks the KEY's board only - a board key can never unlink
  another board. It takes no code: the player is standing at that board's
  ACHIEVE door, which is the proof. It does not delete unlocks; those record
  the board they were earned on.
- Linking appends the server-internal `meta.link` event
  (`type='meta.link', key=<board-id>`, `dim:"board"` for `distinct`), which
  is what makes `boards.linked.2/5/10` reachable. Unlinking does NOT remove
  it: the player did link that board, and a rule about how many boards you
  have linked is not a rule about how many you are currently linked to.
  Written at the site.
- Linking an UNVERIFIED player is `403 unverified_player`.
- Re-linking an already-linked board is a no-op success (idempotent), and
  does not append a second `meta.link`.

**RED -> GREEN tests** (`tests/achievements/links.test.ts`):
- `a board reporting for an email that never linked it is refused` (SYM-5)
- `a link code works exactly once and the second board must use the fresh one`
- `an expired link code is refused and the player can rotate a new one`
- `a board can only unlink itself, never another board`
- `unlinking stops new events and keeps the unlocks already earned`
- `relinking the same board does not append a second meta.link`
- `an unverified player cannot link a board`
- `the profile lists every board that is reporting for the player`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/links.test.ts tests/achievements/players.test.ts
```

**Success criteria.** Eight green; SYM-5 moves here.

---

## Task AC-9 - `POST /events`: validation, idempotency, clamping, counters

The write path. No rule evaluation yet - AC-10 adds it behind the same
endpoint, and this task's tests assert counters, not unlocks.

**`ach/events.ts`** (new) - the endpoint; **`ach/counters.ts`** (new) - the
fold.

Order of operations for one request, all inside ONE
`db.transaction()` so a mid-batch failure leaves nothing half-applied:

1. **Batch-level validation** -> `400` (D3): body is not `{events: [...]}`;
   `events.length > 100` or `=== 0`; any event missing `ref`, `email`, `type`
   or `at`; any `type` matching `^meta\.` (`meta_type_rejected`); any `ref`
   longer than 128 characters or `type` longer than 64.
2. **Per-event resolution.** Unknown email -> `rejected: unknown_player`.
   Unverified -> `unverified_player`. No link for this board ->
   `not_linked`, and the email joins `notLinked`. If EVERY event is
   `not_linked`, the whole response becomes `403 not_linked` instead (the
   68K door's single-player case, and the code SP2's flusher keys on).
3. **Type check.** A type is known if it appears in `achievement_types`, or
   is `stat.snapshot` whose `key` appears there (D10). Otherwise
   `rejected: unknown_event_type`.
4. **Clamp.** `at` is parsed as ISO 8601 UTC. `at > received_at + 900` or
   `at < received_at - 2592000` -> `at = received_at`, `clamped = 1`. Streaks
   and windows read the clamped value; nothing reads the raw one.
5. **Insert** into `events` with `INSERT ... ON CONFLICT(board_id, ref) DO
   NOTHING`. `changes === 0` means duplicate: it increments `duplicates` and
   folds NOTHING. This is the whole idempotency story and it is enforced by
   the primary key, not by a lookup.
6. **Fold** each newly inserted event:
   - `counters` for `(type, '')` and, when `key` is set, `(type, key)`:
     `n += 1`, `sum_value += value`, `first_at = min`, `last_at = max`.
   - `counter_dims` for `dim='key'` (when `key` is set) and `dim='board'`,
     each written twice - `grp=''` and `grp=<key>` - so an ungrouped and a
     key-grouped `distinct` rule both read a row that exists.
   - `counter_days` for the UTC day of the clamped `at`.
   - `stat.snapshot` instead writes `snapshots(name=key)` as
     `max(existing, value)` and folds no counter. A LOWER snapshot after a
     higher one changes nothing at all.
7. **Audit** one `board_audit` row: `<board-id> events <accepted>`.

Response: `{ accepted, duplicates, rejected, notLinked, unlocks: [], progress: [] }`.

**RED -> GREEN tests** (`tests/achievements/events.test.ts`):
- `the same ref sent twice counts once` (SYM-6)
- `an event stamped a year in the future is clamped to now and recorded as clamped` (SYM-7)
- `an event stamped forty days ago is clamped; one stamped twenty days ago is not`
- `a batch of 101 is refused and none of the 101 is stored`
- `a batch containing meta.unlock is refused whole` (SYM-8)
- `one unlinked player in a batch does not stop the other ninety-nine`
- `a batch entirely for unlinked players answers 403 not_linked`
- `an unknown event type is rejected per event, and the response names the ref`
- `a lower stat.snapshot after a higher one does not reduce the counter`
- `a stat.snapshot naming a type no achievement uses is rejected`
- `a failed event batch leaves no counter half-folded` (transaction proof)

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/events.test.ts
```

**Success criteria.** Eleven green; SYM-6, SYM-7 and SYM-8 move here.

---

## Task AC-10 - the rule engine: seven operators as data, plus the cascade

**`ach/engine.ts`** (new). Rules are DATA read out of `achievements.rule`;
there is no per-achievement code anywhere in this plan, and a test asserts
that (`the engine's source names no achievement id`).

```ts
/**
 * Evaluate every achievement that COULD have moved, for every player the
 * batch touched. Candidates come from achievement_types, indexed by type -
 * never from a scan of the catalog.
 */
export function evaluate(db, playerIds: number[], types: string[], boardId: string, now: number): UnlockOut[];
```

Per operator, the exact question asked:

| op | reads | unlocks when |
|---|---|---|
| `count` | `counters(player, type, key ?? '')` and `snapshots(player, type)` | `max(n, snapshot) >= n` |
| `first` | the same row's existence | `n >= 1` |
| `sum` | `counters.sum_value` (incremental only - D10) | `sum_value >= n` |
| `distinct` | `counter_dims(player, type, dim, grp)` | ungrouped: `count(*) >= n`; grouped: `max over grp of count(*) >= n` |
| `streak` | `counter_days(player, type)` | the longest run of consecutive UTC days `>= n` |
| `within` | `events(player, type)` ordered by `at` | some window of `n` events spans `<= window_s` |
| `all` | `unlocks(player)` | every id in `ids` is unlocked |
| `granted` | nothing | never - the server inserts these directly (D11) |

**The cascade.** Inserting an unlock appends the server's own events and
re-enters `evaluate`:
- `meta.unlock` with `key = <achievement id>`, `dim:"board"`, grouped by key -
  which is what makes `boards.same.3` reachable;
- `meta.board_first` when the inserted unlock is the FIRST unlock ever
  recorded for that board (D9), making `rare.newboard.first` reachable.
`all(ids)` achievements are indexed under the pseudo-type `meta.unlock`, so
they become candidates whenever anything unlocks - which is the only way a
meta award can ever fire. The loop is bounded at **5 levels**; hitting the
bound logs `[WARN] achievement cascade depth exceeded` with the player and
the ids, and stops. A test drives a three-level meta chain and asserts all
three unlock in ONE request.

**Unlock rows** carry `board_id` (the reporting board) and `season_id` (from
`ensureCurrentSeason`, AC-15) and are `INSERT ... ON CONFLICT DO NOTHING`
keyed `(player_id, achievement_id)` - an achievement unlocks once, globally,
for ever.

**Progress.** The response's `progress` array holds the not-yet-unlocked
candidates the batch moved, ordered by completion fraction descending and
**capped at 20**. The cap is not cosmetic: a 68K client parses this into a
static buffer (spec, Component 4), and an uncapped array on a first-ever
snapshot sync would be the whole catalog.

**RED -> GREEN tests** (`tests/achievements/engine.test.ts`) - the near-miss
and the duplicate are in every one of them, per the spec's testing section:
- `a hundredth message unlocks Century, ninety-nine does not, and resending the hundredth does not unlock twice` (count)
- `the first upload ever unlocks, and the second upload unlocks nothing` (first)
- `a hundred megabytes uploaded unlocks; ninety-nine does not` (sum)
- `posting in ten different conferences unlocks; ten posts in one conference does not` (distinct, dim key)
- `earning the same achievement on three boards unlocks; three achievements on one board does not` (distinct, dim board, group key)
- `calling on seven consecutive days unlocks; a gap on day four does not` (streak)
- `three messages inside five minutes unlocks; three inside six does not` (within)
- `the file meta award unlocks only when every file achievement is unlocked` (all)
- `a snapshot of a hundred uploads unlocks the hundred-upload award without a hundred events` (snapshot-backed count)
- `a snapshot lower than the stored one unlocks nothing and reduces nothing`
- `a three-level meta chain unlocks all three in one request`
- `a granted-op achievement never unlocks from events`
- `the engine considers only achievements naming a type the batch touched` (call-count on the candidate query)
- `progress never exceeds twenty entries`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/engine.test.ts tests/achievements/events.test.ts
```

**Success criteria.** Fourteen green; every one of the eight operators has at
least one fixture that unlocks, one that nearly does, and one duplicate that
must not.

---

## Task AC-11 - the seed catalog

**`seeds/achievements.seed.json`** (new). `seeds/` is already copied into the
image by `package.json:7` and by `Dockerfile:21`, so no build change is
needed beyond AC-2's.

Every id from the spec's catalog tables, with a concrete rule. Points default
by tier - bronze 5, silver 10, gold 25, platinum 50 - and an entry may
override. Shape:

```json
{
  "formatVersion": 1,
  "achievements": [
    { "id": "msg.post.100", "name": "Century", "description": "Post a hundred messages",
      "family": "msg", "tier": "silver", "hidden": false,
      "rule": { "op": "count", "type": "msg.post", "n": 100 } },
    { "id": "msg.conf.distinct.10", "name": "Well Travelled", "description": "Post in ten different conferences",
      "family": "msg", "tier": "silver", "hidden": false,
      "rule": { "op": "distinct", "type": "msg.post", "dim": "key", "n": 10 } },
    { "id": "presence.everyhour", "name": "Round The Clock", "description": "Log in during all twenty-four hours of the clock",
      "family": "presence", "tier": "gold", "hidden": false,
      "rule": { "op": "distinct", "type": "presence.call", "dim": "key", "n": 24 } },
    { "id": "boards.same.3", "name": "Three Times Over", "description": "Earn the same achievement on three different boards",
      "family": "boards", "tier": "gold", "hidden": false,
      "rule": { "op": "distinct", "type": "meta.unlock", "dim": "board", "group": "key", "n": 3 } },
    { "id": "rare.newboard.first", "name": "Ground Floor", "description": "The first unlock ever recorded on a board",
      "family": "rare", "tier": "gold", "hidden": true,
      "rule": { "op": "count", "type": "meta.board_first", "n": 1 } },
    { "id": "rare.season.winner", "name": "Champion", "description": "Win a season",
      "family": "rare", "tier": "platinum", "hidden": true,
      "rule": { "op": "granted" } }
  ]
}
```

**`ach/catalog.ts`** (new) - `seedCatalog(db, seed)`, called from
`initAchievementsDb` (extending AC-2's, which until now only ran schema and
migrations):
- inserts an id that does not exist, with its digest (D8) and
  `source='seed'`, and fills `achievement_types` from the rule;
- an id that DOES exist is left alone. If the seed's digest differs, it logs
  `[WARN] seed definition for <id> differs from the published one; the
  published one stands` and moves on. **A seed edit can never rewrite a
  published achievement** - the same immutability the API enforces, applied
  to the file, because otherwise a careless edit silently changes what people
  already earned.
- `achievement_types` is rebuilt only for ids it inserts.

**Rule -> types extraction** (the candidate index): `count`/`first`/`sum`/
`distinct`/`streak`/`within` index under their `type`; `all` indexes under
`meta.unlock`; `granted` indexes under nothing.

**RED -> GREEN tests** (`tests/achievements/seed.test.ts`):
- `the seed contains every achievement id named in the design spec` - the id
  list is PINNED IN THE TEST, transcribed from the spec's tables, so a
  dropped achievement is a test failure and not a discovery in six months
- `every seeded rule parses into a known operator and names a type`
- `every seeded achievement indexes at least one candidate type, except the granted one`
- `seeding twice inserts nothing the second time`
- `a seed whose definition differs from a published id warns and does not overwrite`
- `every tier maps to its default points unless the entry overrides`
- `no two achievements share an id, and no id is outside family.slug or door.<name>.<slug> shape`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/seed.test.ts
npm run build && test -f dist/seeds/achievements.seed.json
```

**Success criteria.** Seven green; the pinned id list matches the spec's
tables one for one, and the count is written in the commit message.

---

## Task AC-12 - `GET /catalog` and `GET /catalog.txt`, and ONE text escaper

**The move first.** `esc` (`manifest.ts:349-351`), `oneLine`
(`manifest.ts:353-355`) and `toLatin1Safe` (`manifest.ts:370-377`) move
verbatim into a new `src/text-format.ts`; `manifest.ts` imports them and
re-exports `toLatin1Safe` so no existing importer breaks. Not a copy: two
escapers would let `list.txt` and `catalog.txt` diverge, and a 68K parser
written against one would mis-read the other.

**`GET /catalog?since=<revision>`** -> `CatalogResponse`:
- revision `a<count>-t<max(updated_at)>`, the same fingerprint shape as
  `getCatalogRevision` and for the same reason (never a git SHA - a deploy
  must not invalidate a good client's cache).
- `ETag: "<revision>"` and a 304 through Express's `req.fresh`, computed
  BEFORE the rows are read, exactly as `/manifest` does.
- `since` is parsed for its `-t<epoch>` suffix and returns only rows with
  `updated_at > epoch`. A `since` that does not parse returns the FULL
  catalog and a `200` - never a `400`. An old client with a mangled cursor
  must be able to recover, not be bricked.
- Hidden achievements are LISTED with `hidden: true` but carry an empty
  `description` and the name `???` until the requesting board has a linked
  player who unlocked one. Rationale: the catalog is per-board, not
  per-player, and a hidden achievement's text is the surprise; the flag alone
  would let any client print the answer.

**`GET /catalog.txt?since=`** - the house format, byte for byte:

```
ACHIEVE|1|<revision>|<count>CRLF
<id>|<family>|<tier>|<points>|<hidden>|<name>|<description>|<op>|<rarity_tenths>|<bucket>CRLF
```

- `Content-Type: text/plain; charset=ISO-8859-1`; bytes via
  `Buffer.from(out, 'latin1')` after `toLatin1Safe`.
- `|` -> `!` through `esc`; CR/LF/TAB -> space through `oneLine`; description
  capped at 120 characters after the substitution, like `list.txt`.
- `hidden` is `1`/`0` - a C89 client tests one byte (`manifest.ts:473`).
- `rarity_tenths` is an INTEGER in tenths of a percent (81 = 8.1%): a C89
  door has no float parsing worth relying on.
- **Append-only.** New fields go on the END; a conforming parser ignores
  trailing fields it does not know. Stated in `ACHIEVEMENTS-API.md` and
  pinned by the test below.
- The revision-keyed render cache from `manifest.ts:397-425` is NOT copied:
  the catalog is ~60 rows, not 3301, and a cache with no measured cost to
  avoid is a second thing to invalidate.

**RED -> GREEN tests** (`tests/achievements/catalog.test.ts`):
- `catalog.txt is ISO-8859-1 with CRLF endings and a header naming the revision` (SYM-9)
- `a name containing a pipe is escaped to an exclamation mark, exactly as list.txt escapes it`
- `a non-Latin-1 character becomes a single question mark, not two`
- `a matching If-None-Match answers 304 without reading the achievements table`
- `since returns only what changed, and an unparseable since returns everything with a 200`
- `a hidden achievement's name and description are withheld until somebody on this board unlocks it`
- `list.txt is byte-identical after the escaper move` (the parity guard)

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/catalog.test.ts tests/manifest.test.ts tests/routes.test.ts tests/index-tsv.test.ts
npm run test:parity        # REQUIRED: the escaper moved, list.txt must not have
```

**Success criteria.** Seven green; `tests/manifest.test.ts` passes UNEDITED;
`npm run test:parity` passes with the real fixtures (not skipped - a skipped
parity run is not a passing one, `README.md`). SYM-9 moves here.

---

## Task AC-13 - `PUT /catalog/doors/<door>`: door-defined achievements

**`ach/doors.ts`** (new).

Request: `{ digest, achievements: AchievementDef[] }` (the digest is the
manifest's, so a door only pushes when its manifest changed - SP3's side).

Rejection rules, each a test:
- an id not matching `^door\.<door>\.[a-z0-9_]+$` where `<door>` is the URL
  segment -> `400 bad_namespace`, naming the offending id. A door cannot
  define an achievement in another door's namespace or in a BBS family.
- `<door>` itself must match `^[a-z0-9][a-z0-9-]{1,31}$` -> `400`.
- an id that exists with a DIFFERENT digest -> `409 definition_changed`,
  naming the id, and **the original stands** - the whole request is rejected
  and nothing is written. Partial acceptance would leave a door's catalog
  half-old and half-new with no way for the author to tell.
- an id that exists with the SAME digest -> accepted, counted as unchanged.
- more than 64 achievements in one door -> `400 too_many`.
- a rule whose `op` is unknown, or `granted` (server-only, D11) -> `400 bad_rule`.
- a rule naming a `meta.*` type -> `400 bad_rule`. A door cannot hook the
  server's internal stream.
- `tier` outside the four, `points` outside 1-100, `name`/`description`
  outside 1-64 / 1-160 characters -> `400`.

Accepted definitions are written with `source='door:<door>'`, their
`achievement_types` rows built the same way as the seed's, and
`door_catalog_digests` records the manifest digest so an unchanged manifest
is a cheap no-op. One `board_audit` row: `<board-id> catalog:<door> <count>`.

Response: `{ added, unchanged, total }`.

**RED -> GREEN tests** (`tests/achievements/door-catalog.test.ts`):
- `a door redefining a published id is refused with 409 and the published definition still stands` (SYM-10)
- `an id in another door's namespace is refused, naming the id`
- `re-pushing an unchanged manifest adds nothing and answers 200`
- `a door achievement unlocks through the same POST /events path as a BBS one`
  (the reachability test for this task: a door definition that never fires is
  the failure mode)
- `a door rule naming meta.unlock is refused`
- `a door defining a granted rule is refused`
- `sixty-five achievements in one door are refused whole`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/door-catalog.test.ts tests/achievements/engine.test.ts
```

**Success criteria.** Seven green; SYM-10 moves here.

---

## Task AC-14 - `GET /players/<email>` and the private flag

**`ach/profile.ts`** (new).

```
GET   /players/<url-encoded email>   -> PlayerProfile
PATCH /players/<url-encoded email>   { private?: boolean, handle?: string } -> PlayerProfile
```

- The email is URL-decoded and matched case-insensitively against
  `email_key`.
- **Gated by the LINK, not by the privacy flag** (spec, Component 2): a board
  not linked to that email gets `403 not_linked` whether the player is
  private or not, and whether or not the player exists - so this endpoint is
  not an address oracle.
- The response carries `handle`, never `email`. `linkedBoards` is a list of
  board ids.
- `progress` here is NOT capped at 20 (that cap exists for the event
  response's static buffer); it is capped at 200 and ordered by completion
  fraction, which is what the ACHIEVE door's progress screen pages through.
- `PATCH` changes only the player's own flags, and only from a linked board -
  the player is standing at the door on that board. A handle change is
  subject to the same uniqueness rule as registration.
- Hidden achievements the player has NOT unlocked are omitted from
  `progress` entirely - listing "you are 3/5 towards a secret" is the same
  leak as naming it.

**RED -> GREEN tests** (`tests/achievements/profile.test.ts`):
- `a board not linked to an email is refused, whether or not that player exists`
- `a linked board reading a private player still gets the profile`
- `the profile never contains an email address`
- `setting the profile private from one linked board is visible from another`
- `progress omits hidden achievements the player has not unlocked`
- `a handle change to a taken handle is refused and the old handle stands`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/profile.test.ts
```

**Success criteria.** Six green.

---

## Task AC-15 - leaderboards, seasons, the season winner, rarity

**`ach/leaderboard.ts`, `ach/seasons.ts`, `ach/rarity.ts`** (new).

```
GET /leaderboard?scope=global|board:<id>&period=all|season&limit=<1..200>
```

- `scope=global` ranks VERIFIED, NON-PRIVATE players by points summed over
  their unlocks - excluding unlocks earned on a SUSPENDED board, which is
  what makes the spec's risk-3 mitigation ("a board can be suspended and its
  unlocks recomputed out of the global leaderboard without touching anyone's
  local scoreboard") real rather than aspirational.
- `scope=board:<id>` ranks players linked to that board by points earned ON
  that board (`unlocks.board_id = <id>`). A private player IS listed here -
  that board's caller list is its sysop's own data (spec, Component 2).
- `period=season` filters `unlocks.season_id = <current>`.
- Ties break by earliest last-unlock timestamp, then by handle, so the order
  is total and the `.txt` variant is stable between two identical requests.
- `limit` defaults to 50, caps at 200.

**Seasons** (`ach/seasons.ts`): id `YYYYQn`, boundaries at UTC quarter starts.
`ensureCurrentSeason(db, now)` is called at the top of every write request
(D12): it creates the current season if absent, and for any season whose
`ends_at <= now` and `closed_at IS NULL` it CLOSES it, which means:
- the top GLOBAL player by season points is granted `rare.season.winner`
  (`unlocks` insert, `board_id` = the board of their highest-scoring unlock
  that season, `season_id` = the season being closed);
- the top player of each board **with at least five verified linked players**
  is granted the same. The floor is the spec's, and it is checked against
  verified LINKED players, not callers.
- ranks reset by construction - nothing is deleted, recomputed or
  downgraded, because the season lives on the unlock row.
A season with zero unlocks closes silently and grants nothing.

**Rarity** (`ach/rarity.ts`): `unlocked_verified_players / verified_players`,
buckets common > 25%, uncommon 10-25%, rare 2-10%, epic 0.5-2%, legendary <
0.5%, stored as tenths of a percent. `refreshRarityIfStale(db, now)` runs at
most once per 24 h (`meta.rarity_computed_at`), from the same lazy hook. With
zero verified players every achievement is `legendary` by arithmetic, which
is wrong on day one, so the floor is explicit: **fewer than 20 verified
players means every rarity is `common` and `pct_tenths` is 1000**, and
`ACHIEVEMENTS-API.md` says so.

**`scripts/achievements-season.ts`** (new): `status`, `close --at <iso>`,
`rarity --now <iso>` - so a roll can be forced by hand and tests can drive an
arbitrary clock.

**RED -> GREEN tests** (`tests/achievements/leaderboard.test.ts`):
- `a private player is absent from the global board and present on the board they are linked to` (SYM-11)
- `an unverified player is on no leaderboard at all`
- `unlocks earned on a suspended board leave the global board and stay on that board's own`
- `the board leaderboard counts only the points earned on that board`
- `closing a season grants the winner and leaves every unlock untouched`
- `a board with four verified linked players mints no season winner; five does`
- `season points reset at the roll and all-time points do not`
- `rarity with fewer than twenty verified players is common, not legendary`
- `rarity is recomputed at most once a day`
- `two identical leaderboard requests return the same order`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/leaderboard.test.ts
npx tsx scripts/achievements-season.ts status     # against a temp DB
```

**Success criteria.** Ten green; SYM-11 moves here.

---

## Task AC-16 - `GET /leaderboard.txt`

The same query parameters, the same house format, the same escaper
(`src/text-format.ts` - no third copy):

```
ACHIEVE|1|<revision>|<count>CRLF
<rank>|<handle>|<points>|<unlocks>CRLF
```

`revision` here is the leaderboard's own fingerprint,
`l<rows>-t<max(unlocks.at)>` scoped to the query - so a 68K client can hold
an ETag against a board scoreboard the same way it holds one against the
catalog. `ETag` and 304 as in AC-12. Handles are `oneLine`d, `esc`aped,
`toLatin1Safe`d and capped at 16 characters (the registration cap, so the cap
never actually truncates - it bounds the line against arbitrary future
content, the reasoning `manifest.ts:467-472` records for author and
releaseGroup).

**RED -> GREEN tests** (`tests/achievements/leaderboard-txt.test.ts`):
- `leaderboard.txt is ISO-8859-1 with CRLF and a header naming the row count`
- `a handle containing a pipe is escaped, and the row count still matches the line count`
- `the same query twice returns byte-identical output`
- `a scope naming an unknown board answers an empty listing with a valid header, not a 404`
- `an If-None-Match matching the leaderboard revision answers 304`

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/leaderboard-txt.test.ts
```

**Success criteria.** Five green; a byte-array fixture (built in code, never
written as a UTF-8 source file) compares equal with `Buffer.compare`.

---

## Task AC-17 - rate limits, on the write API only

**`ach/ratelimit.ts`** (new). In-process fixed windows in a `Map` (D15), a
`_resetRateLimitsForTests()` export, and `Retry-After` in seconds on every
`429`. Applied ONLY to these routes:

| route | per board | per player/email |
|---|---|---|
| `POST /events` | 120 requests / min, 12000 events / min | 600 events / min |
| `POST /players`, `POST /players/resend` | 10 / min | 3 / hour (mail is the abusable half) |
| `POST /players/verify` | 30 / min | 10 / hour |
| `POST /links`, `DELETE /links`, `POST /links/rotate` | 30 / min | 10 / hour |
| `PUT /catalog/doors/<door>` | 10 / min | n/a |
| `POST /achievements/v1/admin/*` | 20 / min per admin | n/a |

`GET /catalog`, `/catalog.txt`, `/leaderboard`, `/leaderboard.txt`,
`/players/<email>` and `/health` are NOT limited, and a test asserts that -
the exception the spec grants is narrow, and a limiter on a read path is
exactly the "locks out legitimate BBS users" failure the project-wide rule
exists to prevent. A comment at the top of the file states this in the same
words.

The per-player counter is keyed by `email_key`, so a board cannot dodge it by
re-batching, and an attacker who guesses an address cannot lock its owner out
of anything except more mail.

**RED -> GREEN tests** (`tests/achievements/ratelimit.test.ts`):
- `a board over the event rate gets 429 with a Retry-After in seconds`
- `the next window lets the same board through again`
- `a fourth registration mail for one address in an hour is refused; the board's other players are unaffected`
- `reading the catalog a thousand times is never rate limited`
- `reading the leaderboard a thousand times is never rate limited`
- `a 429 stores no events` (the limiter is in front of the transaction)

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/ratelimit.test.ts
```

**Success criteria.** Six green; the read paths carry no limiter and the test
that proves it names the endpoints one by one.

---

## Task AC-18 - the recorded-week replay

The regression that catches a rule-engine change nobody meant to make.

**`tests/achievements/fixtures/recorded-week.jsonl`** - one JSON event per
line, seven UTC days, three players on two boards, ~400 events. **It is not a
production capture** (D14): no board emits these until SP2 ships. It is
generated once by `tests/achievements/fixtures/make-recorded-week.ts`
(committed beside it), read line by line by a human before it is frozen, and
never regenerated casually - regenerating it is a deliberate act that
requires re-auditing the expected unlock list.

It must contain, and the test asserts each is present in the fixture:
- events for every operator in the seed catalog, including a `stat.snapshot`
  pair (a high one then a lower one);
- a **future-stamped event** (`at` = day 3 + 6 hours ahead of its neighbours)
  and a **40-day-old event**, both of which must clamp;
- a duplicate `ref` sent on two different days;
- a `meta.unlock` cascade that fires `boards.same.3`;
- one event for an unlinked player, and one for an unverified one.

**`tests/achievements/replay.test.ts`** replays the file against a FRESH
database through the real `POST /events` endpoint in batches of at most 100,
and asserts:
- the **EXACT set of unlock ids, in order**, against a committed expected
  list (`recorded-week.expected.json`);
- the exact `accepted` / `duplicates` / `rejected` totals;
- the two clamped events are recorded `clamped = 1` and their streaks are
  computed from the clamped day - the clock-skew handling is pinned INSIDE
  the replay, not in a separate unit test;
- replaying the whole file a SECOND time changes nothing: 0 accepted, 0 new
  unlocks. That is the idempotency proof at the level of a week, not a row.

**Automated verification.**
```
npm run typecheck
npx jest --config jest.config.ts tests/achievements/replay.test.ts
npx jest --config jest.config.ts tests/achievements/     # the whole surface
```

**Success criteria.** The expected-unlocks file is committed and matches; the
second replay is a no-op; any diff in the unlock list fails the build with
the two lists printed side by side.

---

## Task AC-19 - what is DELETED

**Nothing is deleted.** This plan is purely additive to a running service: no
endpoint changes shape, no table is dropped, no column is removed, no file is
deleted, and `doors.db` is not touched at all. Stated as its own task rather
than as a footnote so that it is checked rather than assumed.

Three things MOVE, and the move is verified:

| moved | from | to | proof it is a move, not a copy |
|---|---|---|---|
| `esc` | `manifest.ts:349-351` | `src/text-format.ts` | `grep -c "function esc" src/*.ts src/achievements/*.ts` prints 1 |
| `oneLine` | `manifest.ts:353-355` | `src/text-format.ts` | same, 1 |
| `toLatin1Safe` | `manifest.ts:370-377` | `src/text-format.ts` | same, 1; `manifest.ts` re-exports it so no importer changes |

Two things are AMENDED in place and must keep every existing field:
`ServerConfig` (`config.ts:18-26`, one field added) and the door-repo health
body (`routes.ts:507`, one key added).

**Automated verification.**
```
grep -rn "function esc\b\|function oneLine\b\|function toLatin1Safe\b" src/ | wc -l   # must be 3
git diff --stat origin/main -- src/schema.sql                                          # must be empty
npx jest --config jest.config.ts tests/    # the pre-existing suite, unedited except for the ServerConfig literal
npm run test:parity
```

**Success criteria.** Three greps at 1; `src/schema.sql` untouched; every
pre-existing test file's only diff is `achievements: null` in a config
literal.

---

## Task AC-20 - the reachability ledger

Per `~/.claude/REACHABILITY_PROTOCOL.md` sections 9 and 10. Create
`.superpowers/sdd/2026-09-03-achievements-server/` with `CHECKLIST.md` (all
21 IDs, ticked in the open with a running count) and `REACHED.tsv`
(`id, entry_point, symbols, call_counts, timestamp, commit`), appended per
task and never written in a batch at the end.

**The entry point is always `request(createApp(cfg))`** - the real Express
app from `app.ts:10`, over HTTP, with a real board key in the header. Never a
router, never a function. **Gate 3b is the point: every row carries a
CALL-COUNT SENTINEL, not a source pin.** Sentinels are spied on the MODULE
OBJECT (`jest.spyOn(require('../../src/achievements/engine'), 'evaluate')`),
never on an intra-module call - ts-jest binds those locally and the spy
records zero whether the path ran or not.

Row ids track task ids (`R9` is `AC-9`'s row); there is deliberately no
`R1`, because `AC-1` writes only failing tests and has no code to reach.
Row R0 validates the instrument before any count is quoted: the same walk
against a server built with `achievements: null` must report every sentinel
DEAD, and against a configured one LIVE.

| ID | real entry point driven | symbol whose calls are counted | must be |
|---|---|---|---|
| R0 | the same walk on a configured server and on one with `achievements: null` | `createAchievementsRouter` | LIVE / DEAD |
| R2 | startup with `ACHIEVEMENTS_DB` set, through `initAchievementsDb` | `runMigrations`, `applyAchievementsSchema` | 1 each; `doors.db` table list unchanged |
| R3 | `npx tsx scripts/gen-achievement-types.ts` | `renderMirror` | 1; output contains `ACHIEVEMENTS_CONTRACT_VERSION` |
| R4 | `POST /events` with a valid key, a wrong key, and a suspended board's key | `verifyPassword`, `auditBoard` | 1 verify per cold key, 0 per cached; audit 1 per accepted write |
| R5 | any achievements path on the real app | the router's header middleware | >= 1; header present on a 401 too |
| R6 | `POST /players` with an SMTP stub that refuses | `queueMail`, `Mailer.send` | queue 1, send >= 1, response 202 |
| R7 | `POST /players` then `POST /players/verify` | `hashPassword`, `verifyPassword` | 1 hash per code issued, 1 verify per attempt |
| R8 | `POST /links` after a verify | `appendMetaEvent` with `meta.link` | exactly 1; a relink 0 |
| R9 | `POST /events`, a 100-event batch, half of them duplicates | `foldEvent` | exactly 50; `events` rows 50 |
| R10 | the same batch, carrying a hundredth message | `evaluate`, `insertUnlock` | evaluate >= 1, insert exactly 1; the response's `unlocks[0].id` is `msg.post.100` |
| R11 | startup on a fresh database | `seedCatalog` | 1; `achievements` row count equals the pinned seed count |
| R12 | `GET /catalog.txt` | `toLatin1Safe` from `src/text-format.ts` | >= 1; bytes are Latin-1 with CRLF |
| R13 | `PUT /catalog/doors/grandmaster` then an event for its type | `evaluate`, `insertUnlock` | insert 1; the door-defined id unlocks through the real events path |
| R14 | `GET /players/<email>` from a linked and an unlinked board | `requireLink` | 2; one 200, one 403 |
| R15 | `GET /leaderboard` after a forced season close | `closeSeason`, `insertUnlock` | close 1; `rare.season.winner` inserted exactly once |
| R16 | `GET /leaderboard.txt` | `renderLeaderboardTxt` | 1; byte-equal to the fixture |
| R17 | `POST /events` past the limit | `rateLimit`, `foldEvent` | rateLimit >= 1 and foldEvent 0 on the 429 |
| R18 | the replay, all seven days, real HTTP | `evaluate`, `insertUnlock`, `foldEvent` | the pinned totals; second replay: fold 0, insert 0 |
| R21 | the live host after deploy | `curl` against `doors.uprough.net` | plain HTTP 200, not 301 |

**Verification.** `REACHED.tsv` has 19 rows with R0 first; `CHECKLIST.md`'s
ticked count equals the DONE count and is reported with every progress
message (`[x] AC-9 - 9 of 21, 12 open`).
**Success criteria.** No task is DONE without its row. A row whose count is 0
is a FAILED item and is reported as such, never rounded up. The ratchet (the
count of not-DONE IDs) is committed and CI fails if it rises.

---

## Task AC-21 - deployment, the Caddy exemption, docs, freshness, handoff (last, mandatory)

### Automated (all must pass, in this order)

```
npm run typecheck
npm run test:ci
npm run test:parity          # NOT optional: AC-12 moved the escaper
npm run build && test -f dist/src/achievements/schema.sql && test -f dist/seeds/achievements.seed.json
node -e "require('./dist/src/app.js'); console.log('[OK] compiled server loads')"
docker build -t doorserver-local .        # proves nodemailer and the schema copy survive the image
```

### Repo edits

- **`docker-compose.yml:19-31`** gains, beside the existing environment block:
  ```yaml
      ACHIEVEMENTS_DB: /data/achievements.db
      ACHIEVEMENTS_SMTP_URL: ${ACHIEVEMENTS_SMTP_URL:-}
      ACHIEVEMENTS_MAIL_FROM: ${ACHIEVEMENTS_MAIL_FROM:-}
      ACHIEVEMENTS_BASE_URL: ${ACHIEVEMENTS_BASE_URL:-https://doors.uprough.net}
  ```
  `achievements.db` sits on the EXISTING `doorserver-data` volume next to
  `doors.db` (spec, Deployment: no new container, no new volume).
  **`ACHIEVEMENTS_DB` is only set once SMTP is configured on the host** (D7:
  set-but-incomplete is a startup failure, and this compose file is what the
  live container reads).
- **`.github/workflows/deploy-doorserver.yml`** writes the three new values
  into `.env` exactly as it already writes `DOORSERVER_JWT_SECRET`
  (`deploy-doorserver.yml:34-49`), from three new repository secrets, and the
  post-deploy step gains the two curls below.
- **`Dockerfile`** needs no change: `src/` and `seeds/` are already copied
  (`Dockerfile:18-21`), and the `require('./dist/src/app.js')` proof at
  `Dockerfile:54` now also proves the achievements modules load.
- **`README.md`** gains the four variables in its configuration table and a
  line in "Commands" for `scripts/achievements-board.ts` and
  `scripts/achievements-season.ts`.
- **`docs/ACHIEVEMENTS-API.md`** gets its final pass: every endpoint's real
  captured example replaces the shapes AC-3 wrote from the spec. Captured by
  executing the real server, in the standard
  `docs/DOOR-REPO-API.md:10-13` sets ("nothing here is invented").

### MANUAL host step: the Caddy HTTPS-redirect exemption

The live Caddyfile is host-only and not in version control (project memory:
"Live Caddyfile is host-only"). Today it exempts `/api/door-repo/*` from the
site-wide HTTPS redirect so AmigaDOS TCP/IP stacks can reach it;
`/achievements/v1/*` needs the same exemption or **every 68K client gets a
`301` it cannot follow**.

1. `ssh root@doors.uprough.net`
2. `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)`
3. In the `http://doors.uprough.net` block, beside the existing
   `/api/door-repo/*` matcher, add `/achievements/v1/*` to the SAME matcher
   (one matcher, two prefixes - a second block is a second thing to keep in
   step). Do NOT add any `header` directive: Express sets CORP itself and a
   duplicate header cost a full day once already (`cors.ts:33-40`).
4. `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`

**Verified by measurement, not by assumption** - the two curls, and their
required answers:

```
curl -s -o /dev/null -w '%{http_code}\n' http://doors.uprough.net/achievements/v1/catalog.txt
-> 200        (NOT 301: a 301 means the exemption did not take)
curl -s -o /dev/null -w '%{http_code}\n' http://doors.uprough.net/health
-> 301        (an unrelated path must STILL redirect; a 200 here means the
               exemption is too wide and the whole site went plain)
```

Both run again after the deploy and their output is pasted into the handoff.

### Post-deploy verification (a green workflow lies)

```
ssh root@doors.uprough.net 'docker inspect -f "{{.Created}}" $(docker ps --format "{{.Names}}" | grep doorserver | head -1)'
curl -s https://doors.uprough.net/api/door-repo/health | head -c 400
curl -s https://doors.uprough.net/achievements/v1/health -H "Authorization: Board $KEY"
```
The image's `Created` timestamp must be from THIS deploy, and the health
object must report the contract version this branch declares. The workflow's
colour proves nothing.

### Manual verification (the sysop's - never ticked by the implementer)

- Mint a board key with `scripts/achievements-board.ts create uprough "Up Rough"`
  on the host and keep it out of the shell history.
- Register a real address; the mail arrives, is readable on an Amiga, and the
  code verifies.
- Link the board with the code; the profile lists the board.
- Post a handful of events by curl; the response carries an unlock.
- `curl http://.../achievements/v1/catalog.txt | head -3` from a machine with
  no TLS, and read the header line.
- Suspend the board, confirm `403`, resume it.

### Handoff

`thoughts/shared/handoffs/2026-09-03_achievements-sp1.md`: what shipped, the
contract version, the three `[ESCALATE]` decisions and the controller's
answer, the Caddy step with its curl output, the board keys issued (ids only,
never the keys), and what SP2/SP3/SP4 now depend on. This repo has no
root-level `handoff.md` convention (the sibling repo does); the archive is
the record here.

**Success criteria.** Every command above green; both curls give 200 and 301
respectively; the live health object reports contract version `1`;
`CHECKLIST.md` shows 21 of 21.

---

## Sequencing and dependencies

```
AC-1  (RED, 11 symptoms; each moves into its owning task)
  |
AC-2  (storage: config, db, schema, migrations)
  |
  +--> AC-3  (CONTRACT + docs) ==> UNBLOCKS SP2 and SP4 <==
  |
AC-4  (boards, key auth) --> AC-5 (mount, health) --> AC-6 (mail)
                                       |                 |
                                       |            AC-7 (players)
                                       |                 |
                                       |            AC-8 (links)
                                       |                 |
                                       +-----------> AC-9 (events, counters)
                                                         |
                                                    AC-10 (rule engine)
                                                         |
                        +--------------+-----------------+-------------+
                        v              v                 v             v
                   AC-11 (seed)   AC-13 (door PUT)  AC-14 (profile) AC-15 (boards/seasons)
                        |                                                |
                   AC-12 (catalog + catalog.txt)                    AC-16 (leaderboard.txt)
                        |                                                |
                        +---------------------+--------------------------+
                                              v
                                        AC-17 (rate limits)
                                              |
                                        AC-18 (recorded-week replay)
                                              |
AC-19 (deletions: none) ----------------------+
AC-20 (ledger; appended per task, closed before AC-21) --> AC-21 (deploy, Caddy, docs, handoff)
```

**21 tasks.** The edges that are not obvious, each with the file that forces
it:

| edge | why |
|---|---|
| AC-2 before AC-3 | the contract's `CatalogAchievement` names columns; freezing a shape the storage cannot hold is how a contract goes stale on day one |
| **AC-3 before SP2 starts** | the umbrella spec's sequencing: SP1 and SP2 run in parallel from the moment `contract/achievement-types.ts` is committed, and nothing else in SP1 gates them |
| AC-4 before AC-5 | the mount is meaningless without the gate; a surface that answers before `requireBoard` exists is a public write API for however long that lasts |
| AC-6 before AC-7 | a registration that cannot queue mail is the spec's stated worst case; the queue exists before the endpoint that fills it |
| AC-9 before AC-10 | both edit `ach/events.ts` - AC-9 writes the fold, AC-10 hangs `evaluate` off its tail. Sequenced, never parallel |
| AC-11 before AC-12 | `catalog.txt`'s tests need real rows, and the pinned seed count is what the revision fingerprint is asserted against |
| AC-10 before AC-13 | a door definition that never fires is this task's whole failure mode, and only AC-10 can prove it fires |
| AC-15 before AC-16 | the `.txt` variant renders what the JSON one computes; the ordering rule (ties broken to a total order) has to exist before bytes are pinned |
| AC-17 after every write endpoint | a limiter written against three of the six routes silently leaves three open |
| AC-18 last of the functional tasks | it replays through every one of them |
| AC-12 before AC-21 | the escaper move makes `npm run test:parity` a REQUIRED pre-deploy gate, and AC-21 is where it runs against the real corpus |

Parallel-safe pairs, by the files they touch: AC-13 (`ach/doors.ts`) and
AC-14 (`ach/profile.ts`) share nothing; AC-15/AC-16 (`ach/leaderboard.ts`,
`ach/seasons.ts`) touch neither. AC-12 is the only task that edits
`manifest.ts` and so never collides with anything.

---

## Risk register

| risk | task | mitigation |
|---|---|---|
| **The escaper move shifts a `list.txt` byte** and every 68K door parses a different catalog | AC-12 | the functions move verbatim; `tests/manifest.test.ts` must pass UNEDITED; `npm run test:parity` against the real corpus is a required gate in AC-12 AND AC-21 |
| **The achievements mount shadows the single-page app** or is shadowed by its catch-all (`app.ts:61`) | AC-5 | the mount is placed above `mountWebUi`, and `tests/web-ui.test.ts` must pass unedited plus a new test asserting an achievements path never returns `index.html` |
| **The new `schema.sql` is not copied into the image** and the container crash-loops on `readFileSync` | AC-2, AC-21 | the `build` script copies it, `test -f dist/src/achievements/schema.sql` is in both verification blocks, and `Dockerfile:54` already proves the compiled server loads. This exact failure has happened once here (`Dockerfile:49-53`) |
| **scrypt on the write path** makes `POST /events` cost 50 ms of CPU per call | AC-4 | D1 (one hash, never N) and D2 (a cache invalidated by the row itself); the ledger's R4 counts the verifies and asserts 0 on a cached key |
| **A cascade loop** between two `all` achievements spins the request | AC-10 | depth bounded at 5, a `[WARN]` line naming the player and the ids, and a test that drives a three-level chain |
| **A seed edit rewrites a published achievement** and changes what people already earned | AC-11 | the loader never updates an existing id; a differing digest warns and the published definition stands |
| **The Caddy exemption is too wide** and the whole site goes plain HTTP | AC-21 | the second curl (`http://.../health` must still be `301`) is a required post-step, and the Caddyfile is backed up first |
| **Mail goes to spam** and registration fails silently | AC-6, AC-21 | `POST /players/resend`, the `pendingMail` count on `/health`, a short typeable code, and a manual end-to-end mail test in AC-21's sysop list |
| **A board floods a player's counters** (spec risk 3) | AC-15, AC-17 | per-board and per-player caps; every unlock records its board; a suspended board's unlocks leave the global leaderboard by query, with no migration and no data loss |
| **The `rejected` array (D3) is misread as retryable** by SP2 and rows are retried for ever | AC-3 | `ACHIEVEMENTS-API.md` states TERMINAL vs RETRYABLE explicitly, and SP2's flusher tests are written against that section |

---

## Coverage table - every spec requirement, pinned to a task

| spec requirement | task | proof |
|---|---|---|
| separate `ACHIEVEMENTS_DB` and its migrations | AC-2 | `doors.db` table list unchanged after a full run |
| mount at `/achievements/v1` beside `/api/door-repo` | AC-5 | mount test + web-ui test unedited |
| Caddy HTTPS-redirect exemption, MANUAL, verified by curl | AC-21 | 200 on the achievements path, 301 on an unrelated one |
| board registration and scrypt key hashing | AC-4 | 401/403 tests, `verifyPassword` call count |
| player registration + emailed verification code | AC-6, AC-7 | 202 while SMTP is down; code lifecycle tests |
| refuse to mount without SMTP | AC-2, AC-5 | startup test naming the variable |
| linking and unlinking | AC-8 | eight link tests, `meta.link` appended once |
| `POST /events`, batch <= 100 | AC-9 | 101 refused, none stored |
| idempotency by `ref` | AC-9, AC-18 | PK conflict; a whole week replayed twice |
| increment and `stat.snapshot` (kept as max) | AC-9, AC-10 | a lower snapshot reduces nothing |
| clock-skew clamping (15 min / 30 days, UTC streak days) | AC-9, AC-18 | clamped inside the replay |
| the `meta.*` namespace: appended by the server, refused from boards | AC-8, AC-9, AC-10 | a batch with `meta.unlock` is refused whole |
| rules as DATA: count, streak, first, sum, distinct (dim/group), within, all | AC-10 | one fixture per operator, each with a near-miss and a duplicate |
| catalog with versioning; a published id is immutable | AC-11, AC-12, AC-13 | seed warns and does not overwrite; `PUT` answers 409 |
| door-defined registration `PUT /catalog/doors/<door>` and its rejections | AC-13 | seven rejection tests |
| `GET /catalog` + `/leaderboard` in JSON | AC-12, AC-15 | shape tests against the contract module |
| the plain-text variants for 68K (`ACHIEVE\|1\|<rev>`, CRLF, Latin-1, pipes, append-only) | AC-12, AC-16 | byte fixtures compared with `Buffer.compare` |
| `GET /players/<email>`, handle-only, private-profile flag | AC-14 | no response body contains an `@` |
| seasons and the season-winner rule (top global + top of each board with >= 5 verified linked players) | AC-15 | four-player board mints none; five does |
| rate limits scoped to the write API only | AC-17 | the read paths are named one by one in a test |
| the recorded-week replay pinning an unlock set | AC-18 | exact ids, in order, plus a no-op second pass |
| the contract module SP2 and SP4 code against | AC-3 | committed before either starts |
| what is deleted | AC-19 | nothing; three functions move, greps at 1 |
| reachability ledger with call-count sentinels | AC-20 | 19 rows, R0 validates the instrument |
