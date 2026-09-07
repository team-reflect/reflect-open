-- `note_text` held a note's extracted plain text "for FTS + AI context"
-- (Plan 03/04). Neither consumer is still there: FTS has `search_fts.body`,
-- the AI's read_notes tool reads the file from disk, and All Notes moved to
-- the stored `notes.preview` column. No query has read it since, so every note
-- write has been storing a second copy of the body that nothing consults.
--
-- Dropping it changes no other row's derivation, so this needs no projection
-- version bump and no reindex.

DROP TABLE note_text;
