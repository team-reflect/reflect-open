-- Pinned notes: the `pinned: true` frontmatter flag, projected so the
-- sidebar's Pinned section and the `is:pinned` filter query it without
-- re-reading files. Markdown stays the source of truth; this is rebuildable.

ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
-- Explicit pin order from `pinned: <n>` frontmatter (the future reorder UI's
-- encoding; REAL so fractional ranks make an insertion a one-file write).
-- NULL for bare `pinned: true` — those sort after ordered pins, by title.
ALTER TABLE notes ADD COLUMN pinned_order REAL;

-- The flag is extracted at index time, and the open-time reconcile hash-skips
-- unchanged files — rows indexed before this migration would keep is_pinned=0
-- even where the file already says `pinned: true`, until the file happened to
-- change. The projection is rebuildable by design: drop the note rows (child
-- tables explicitly — FK enforcement isn't guaranteed during migrations) so
-- the next open re-indexes every file with the new column populated.
-- `index_meta` is bookkeeping and `embedding_chunks`/`embedding_vectors` are
-- content-hash-keyed (re-indexing unchanged notes must not re-embed them), so
-- they survive.
DELETE FROM note_text;
DELETE FROM links;
DELETE FROM tags;
DELETE FROM aliases;
DELETE FROM assets;
DELETE FROM notes;
DELETE FROM search_fts;
