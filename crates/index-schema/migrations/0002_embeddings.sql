-- Plan 09: chunk-level embeddings. `embedding_chunks` deliberately has NO
-- foreign key to `notes`: apply_note re-creates the note row on every index
-- pass (delete + insert), and a cascade would wipe the chunks each save —
-- destroying the hash-skip that makes re-embedding incremental. Chunk
-- lifecycle is owned by the embedding pipeline (embed_apply / embed_remove);
-- vectors live in the vec0 table keyed by the chunk's rowid.

CREATE TABLE embedding_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_path TEXT NOT NULL,
  heading TEXT,
  pos_from INTEGER NOT NULL,
  pos_to INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL
);
CREATE INDEX embedding_chunks_note ON embedding_chunks(note_path);

CREATE VIRTUAL TABLE embedding_vectors USING vec0(embedding float[384]);
