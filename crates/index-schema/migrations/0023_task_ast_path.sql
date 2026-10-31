-- Tasks are addressed by their position in the note body's block AST instead
-- of by a character offset, so a format-only rewrite of the note does not move
-- them. `ast_path` is the JSON array of child indexes from the body root
-- (`[2,1]`); readers sort tasks by comparing it, so no position column is kept.
-- `markdown` is the task paragraph without its marker; plain text is derived
-- at read time. A pure projection, rebuilt from Markdown by the projection
-- version bump; dropping the table also drops its partial indexes, so they are
-- recreated here.
DROP TABLE tasks;
CREATE TABLE tasks (
  note_path   TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  ast_path    TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  checked     INTEGER NOT NULL,
  due_date    TEXT,
  breadcrumbs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (note_path, ast_path)
);
CREATE INDEX tasks_open_by_note ON tasks(note_path) WHERE checked = 0;
CREATE INDEX tasks_completed_by_note ON tasks(note_path) WHERE checked = 1;
