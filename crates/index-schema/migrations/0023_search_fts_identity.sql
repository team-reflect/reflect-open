-- FTS5 cannot index its UNINDEXED path column. Resolve a note through this
-- ordinary unique index before mutating search_fts by its integer rowid.
-- The internal identity is independent of optional, non-unique notes.id.
CREATE TABLE note_search (
  rowid INTEGER PRIMARY KEY,
  note_path TEXT NOT NULL UNIQUE REFERENCES notes(path) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Keep existing FTS rows and their ranking/snippet content byte-for-byte;
-- no projection rebuild or changes to durable chat history are needed.
INSERT INTO note_search(rowid, note_path)
  SELECT search_fts.rowid, search_fts.path
  FROM search_fts JOIN notes ON notes.path = search_fts.path;
