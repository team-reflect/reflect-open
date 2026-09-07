-- Two projection changes that share one rebuild.
--
-- `note_text` held a note's extracted plain text "for FTS + AI context"
-- (Plan 03/04). Neither consumer is still there: FTS has its own
-- `search_fts.body`, the AI's read_notes tool reads the file from disk, and
-- All Notes moved to the stored `notes.preview` column. Nothing has selected
-- from this table since, so it is a full copy of every note body that no read
-- ever uses.
--
-- `has_content` answers "would this note render blank": the calendar dot must
-- not mark a day whose daily note is empty, and a daily note cannot be deleted
-- in-app, so such a dot is permanent. Derived at index time from the note's
-- display text plus its asset and link rows.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0017).

DROP TABLE note_text;

ALTER TABLE notes ADD COLUMN has_content INTEGER NOT NULL DEFAULT 0;
