-- `has_content` answers "would this note render blank". A daily note cannot be
-- deleted in-app, so a calendar dot keyed on the file alone never clears.
--
-- No wipe here. The TS projection version bump reindexes every note, so no row
-- keeps the migration default (same contract as 0017).

ALTER TABLE notes ADD COLUMN has_content INTEGER NOT NULL DEFAULT 0;
