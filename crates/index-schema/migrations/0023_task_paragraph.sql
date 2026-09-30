DROP TABLE tasks;
CREATE TABLE tasks (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ast_path TEXT NOT NULL,
    text TEXT NOT NULL,
    checked INTEGER NOT NULL CHECK (checked IN (0, 1)),
    due_date TEXT,
    breadcrumbs TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (note_path, ast_path)
);
CREATE INDEX tasks_open_by_note ON tasks(note_path) WHERE checked = 0;
CREATE INDEX tasks_completed_by_note ON tasks(note_path) WHERE checked = 1;
DELETE FROM index_meta WHERE key = 'projection_version';
