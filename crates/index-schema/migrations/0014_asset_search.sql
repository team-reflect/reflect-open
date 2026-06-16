-- Asset description sidecars in lexical search. These rows are rebuildable from
-- managed `assets/*.reflect.md` sidecars plus the note -> asset references in
-- the ordinary note projection.

CREATE TABLE asset_search (
  note_path    TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  asset_path   TEXT NOT NULL,
  sidecar_path TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  sidecar_hash TEXT NOT NULL,
  text         TEXT NOT NULL,
  PRIMARY KEY (note_path, asset_path)
);
CREATE INDEX asset_search_asset_path ON asset_search(asset_path);

CREATE VIRTUAL TABLE asset_search_fts USING fts5(note_path UNINDEXED, asset_path UNINDEXED, body);
