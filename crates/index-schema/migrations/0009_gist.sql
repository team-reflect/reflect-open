-- Gist publishing: a note published to a GitHub Gist records the gist in its
-- `gist` frontmatter block (id, url, file, hash of the published body), and
-- the indexer projects what the UI needs — the gist link and whether the body
-- has changed since it was last published. Markdown stays the source of
-- truth; both columns are rebuildable.

ALTER TABLE notes ADD COLUMN gist_url TEXT;
-- The body no longer matches the published hash — the UI's "republish" nudge.
-- Computed at index time so queries never re-read or re-hash files.
ALTER TABLE notes ADD COLUMN gist_stale INTEGER NOT NULL DEFAULT 0;

-- Same projection-wipe rationale as 0004/0006: the columns are extracted at
-- index time and the open-time reconcile hash-skips unchanged files, so
-- pre-migration rows would keep gist_url NULL even where the file already
-- carries a `gist` block. Drop the note rows so the next open re-indexes with
-- the new columns populated (index_meta, the content-hash-keyed embedding
-- tables, and the chat_* tables survive).
DELETE FROM note_text;
DELETE FROM links;
DELETE FROM tags;
DELETE FROM aliases;
DELETE FROM assets;
DELETE FROM notes;
DELETE FROM search_fts;
