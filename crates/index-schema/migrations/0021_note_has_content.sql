-- Two projection changes that share one rebuild.
--
-- `note_text` held a note's extracted plain text "for FTS + AI context"
-- (Plan 03/04). Neither consumer is still there: FTS has `search_fts.body`,
-- the AI's read_notes tool reads the file from disk, and All Notes moved to
-- the stored `notes.preview` column. No query has read it since.
--
-- `has_content` answers "would this note render blank". A daily note cannot be
-- deleted in-app, so a calendar dot keyed on the file alone never clears.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0017).

DROP TABLE note_text;

ALTER TABLE notes ADD COLUMN has_content INTEGER NOT NULL DEFAULT 0;
