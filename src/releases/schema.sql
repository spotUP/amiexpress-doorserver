-- The releases database: every file entry of the AquaScan BBS file listing,
-- in its own file (releases.db), never in doors.db. No archives live here,
-- only the listing: filename, flag, size-or-note, date, and what the
-- extractor read out of the entry's mini file_id.
--
-- Identity is (dir_no, file_no, filename): file numbers restart at 1 per
-- dir, AND dir 66 was captured twice with different files reusing numbers
-- (an older 4,553-entry pass plus an appended 4,319-entry 2026 pass). A key
-- on (dir_no, file_no) alone would let the second pass destroy the first.
-- Re-running the importer upserts on the triple: same file re-listed updates
-- in place, different files sharing numbers both survive.

CREATE TABLE IF NOT EXISTS release_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_no      INTEGER NOT NULL,
  file_no     INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  flag        TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER,              -- NULL when the size column holds a note
  size_note   TEXT,                 -- nuke reason (">NUKED<", "DELETED", …)
  date_iso    TEXT NOT NULL,        -- entry date, YYYY-MM-DD
  dl_count    INTEGER,              -- "d/L tIMES:" value, newer entries only
  uploader    TEXT,                 -- "Name >>note<<" trailer, best-effort
  description TEXT,                 -- analyseDoor over the desc lines
  version     TEXT,
  author      TEXT,
  raw_desc    TEXT NOT NULL,        -- desc lines joined, before extraction
  UNIQUE (dir_no, file_no, filename)
);

CREATE INDEX IF NOT EXISTS idx_release_files_filename ON release_files(filename);
CREATE INDEX IF NOT EXISTS idx_release_files_date ON release_files(date_iso);
CREATE INDEX IF NOT EXISTS idx_release_files_flag ON release_files(flag);
