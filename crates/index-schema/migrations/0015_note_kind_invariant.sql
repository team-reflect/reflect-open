-- Enforce the kind/daily_date invariant at the schema level: kind = 'daily'
-- iff daily_date is set. Both columns are derived from the path at index time
-- (`buildIndexedNote`), so every row written by the indexer agrees by
-- construction — but nothing made SQLite reject a drifted writer, and surfaces
-- filter on one column or the other interchangeably.
--
-- SQLite cannot ADD a table-level CHECK to an existing table, so `notes` is
-- dropped and recreated with the constraint — and, like 0004/0006/0014, the
-- projection is wiped rather than copied so the next open re-indexes from
-- markdown. Wiping the children first also keeps the DROP safe under the
-- app's runtime `PRAGMA foreign_keys = ON`: DROP TABLE runs an implicit
-- DELETE FROM, and the child tables' ON DELETE CASCADE clauses have nothing
-- left to fire on. `index_meta` is bookkeeping and the embedding tables are
-- content-hash-keyed, so they survive; `chat_*` is durable history and must
-- never be touched.
DELETE FROM note_text;
DELETE FROM links;
DELETE FROM tags;
DELETE FROM aliases;
DELETE FROM assets;
DELETE FROM tasks;
DELETE FROM notes;
DELETE FROM search_fts;

DROP TABLE notes;

CREATE TABLE notes (
  path TEXT PRIMARY KEY NOT NULL,
  id TEXT,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  daily_date TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_order REAL,
  preview TEXT NOT NULL DEFAULT '',
  has_conflict INTEGER NOT NULL DEFAULT 0,
  gist_url TEXT,
  gist_stale INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('daily', 'note', 'template')),
  CHECK ((kind = 'daily') = (daily_date IS NOT NULL))
);

-- Recreate every index the DROP took with it (0001, 0007, 0010, 0013). The
-- child tables' REFERENCES clauses and the `note_keys`/`backlinks` views
-- (0014) bind to `notes` by name, so they resolve against the recreated
-- table unchanged.
CREATE INDEX notes_title_key ON notes(title_key);
CREATE INDEX notes_daily_date ON notes(daily_date);
CREATE INDEX notes_id ON notes(id) WHERE id IS NOT NULL;
CREATE INDEX notes_daily_date_mtime_path ON notes(daily_date, mtime DESC, path);
CREATE INDEX notes_non_daily_mtime ON notes(mtime DESC, path) WHERE daily_date IS NULL;
CREATE INDEX notes_pinned ON notes(is_pinned, pinned_order, title_key, path) WHERE is_pinned = 1;
CREATE INDEX notes_has_conflict ON notes(path) WHERE has_conflict = 1;
