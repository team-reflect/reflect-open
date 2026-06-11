-- Plan 09 follow-up: store cosine distances natively instead of recovering
-- them from vec0's default L2 metric in TypeScript. The MiniLM vectors are
-- unit-normalized, so KNN *ordering* is unchanged — only the distance scale
-- changes, and retrieval now thresholds on it directly. The vectors
-- themselves are copied as-is (no re-embedding); the round trip goes through
-- a temp table because vec0 ships no ALTER TABLE support.

CREATE VIRTUAL TABLE embedding_vectors_migrate USING vec0(embedding float[384] distance_metric=cosine);
INSERT INTO embedding_vectors_migrate(rowid, embedding)
  SELECT rowid, embedding FROM embedding_vectors;
DROP TABLE embedding_vectors;

CREATE VIRTUAL TABLE embedding_vectors USING vec0(embedding float[384] distance_metric=cosine);
INSERT INTO embedding_vectors(rowid, embedding)
  SELECT rowid, embedding FROM embedding_vectors_migrate;
DROP TABLE embedding_vectors_migrate;
