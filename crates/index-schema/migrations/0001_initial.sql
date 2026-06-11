-- Plan 04 — initial index schema (v1).
--
-- The rebuildable projection over the markdown graph. Backlinks resolve at query
-- time (a `links` <-> note-title/alias/date join via the `note_keys` view) so
-- creating a note immediately resolves inbound links without re-indexing sources.

CREATE TABLE notes (
  path TEXT PRIMARY KEY NOT NULL,
  id TEXT,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  daily_date TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notes_title_key ON notes(title_key);
CREATE INDEX notes_daily_date ON notes(daily_date);

CREATE TABLE note_text (
  note_path TEXT PRIMARY KEY NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  text TEXT NOT NULL
);

CREATE TABLE links (
  source_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('wiki', 'md')),
  target_raw TEXT NOT NULL,
  target_key TEXT NOT NULL,
  alias TEXT,
  pos_from INTEGER NOT NULL,
  pos_to INTEGER NOT NULL
);
CREATE INDEX links_source ON links(source_path);
CREATE INDEX links_target_key ON links(target_key);

CREATE TABLE tags (
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  tag TEXT NOT NULL
);
CREATE INDEX tags_tag ON tags(tag);
CREATE INDEX tags_note ON tags(note_path);

CREATE TABLE aliases (
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL
);
CREATE INDEX aliases_key ON aliases(alias_key);

CREATE TABLE assets (
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  asset_path TEXT NOT NULL
);
CREATE INDEX assets_note ON assets(note_path);

-- Reserved key/value bookkeeping (e.g. last-rebuild marker). Not written yet;
-- preserved across `index_clear` so it can hold values that outlive a rebuild.
CREATE TABLE index_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);

CREATE VIRTUAL TABLE search_fts USING fts5(path UNINDEXED, title, body);

CREATE VIEW note_keys AS
  SELECT path AS note_path, title_key AS key FROM notes
  UNION
  SELECT note_path, alias_key AS key FROM aliases
  UNION
  SELECT path AS note_path, daily_date AS key FROM notes WHERE daily_date IS NOT NULL;

CREATE VIEW backlinks AS
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw, l.alias, l.pos_from, l.pos_to
  FROM links l JOIN note_keys k ON k.key = l.target_key
  WHERE l.kind = 'wiki';
