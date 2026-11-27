-- EmbeddingGemma's truncated vectors replace all-MiniLM-L6-v2's. vec0 has a
-- fixed width and no ALTER TABLE, and the old vectors mean nothing to the new
-- model, so empty `embedding_chunks` and recreate `embedding_vectors`. The
-- embedding sync re-embeds every note.
--
-- An older app keeps using this index (MIN_COMPATIBLE_SCHEMA_VERSION stays):
-- its vector inserts fail inside their transaction, so it loses only semantic
-- search, while lexical search, backlinks and tasks keep working.

DELETE FROM embedding_chunks;
DROP TABLE embedding_vectors;
CREATE VIRTUAL TABLE embedding_vectors USING vec0(embedding float[256] distance_metric=cosine);
