-- EmbeddingGemma (256 dimensions after Matryoshka truncation) replaces
-- all-MiniLM-L6-v2 (384). vec0 has a fixed width and no ALTER TABLE, and the
-- old vectors mean nothing to the new model, so drop and recreate both tables'
-- contents. The embedding sync re-embeds every note.
--
-- An older app keeps using this index (MIN_COMPATIBLE_SCHEMA_VERSION stays):
-- its 384-dimension inserts fail inside their transaction, so it loses only
-- semantic search, while lexical search, backlinks and tasks keep working.

DELETE FROM embedding_chunks;
DROP TABLE embedding_vectors;
CREATE VIRTUAL TABLE embedding_vectors USING vec0(embedding float[256] distance_metric=cosine);
