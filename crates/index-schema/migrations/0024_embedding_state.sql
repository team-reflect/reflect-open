-- A successful complete chunk projection, including an empty note. No FK:
-- note replacement deletes/reinserts notes, while embeddings survive saves.
CREATE TABLE embedding_state (
  note_path TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL
);
