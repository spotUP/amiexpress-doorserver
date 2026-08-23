CREATE TABLE IF NOT EXISTS door_catalog (
  id                  TEXT PRIMARY KEY,
  archive_name        TEXT NOT NULL UNIQUE,
  archive_path        TEXT NOT NULL,
  binary_name         TEXT,
  door_type           TEXT DEFAULT 'XIM',
  name                TEXT NOT NULL,
  version             TEXT,
  author              TEXT,
  release_group       TEXT,
  description         TEXT,
  file_id_diz         TEXT,
  doc_filename        TEXT,
  doc_raw             TEXT,
  suggested_tooltypes TEXT,
  category            TEXT,
  archive_size        INTEGER DEFAULT 0,
  junk_count          INTEGER DEFAULT 0,
  corpus_id           TEXT,
  source              TEXT DEFAULT 'scan',
  indexed_at          INTEGER DEFAULT (strftime('%s','now')),
  md5                 TEXT,
  sha256              TEXT
);
CREATE INDEX IF NOT EXISTS idx_door_catalog_category ON door_catalog(category);
CREATE INDEX IF NOT EXISTS idx_door_catalog_name ON door_catalog(name);

CREATE TABLE IF NOT EXISTS door_catalog_files (
  catalog_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER DEFAULT 0,
  is_junk     INTEGER DEFAULT 0,
  junk_reason TEXT,
  PRIMARY KEY (catalog_id, path)
);
CREATE INDEX IF NOT EXISTS idx_dcf_catalog_id ON door_catalog_files(catalog_id);
CREATE INDEX IF NOT EXISTS idx_dcf_is_junk ON door_catalog_files(is_junk);
