-- The app no longer reads conflict markers, so `notes.has_conflict` has no
-- writer or reader. SQLite refuses to drop a column that an index uses, so the
-- partial index goes first.
DROP INDEX IF EXISTS notes_has_conflict;
ALTER TABLE notes DROP COLUMN has_conflict;
