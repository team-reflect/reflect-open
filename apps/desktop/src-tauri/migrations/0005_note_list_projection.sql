-- All Notes list projection: a stored row preview and folded tag keys.
--
-- `preview` is the list-row snippet, derived once at index time in TS
-- (`buildIndexedNote`) instead of per query. `tag_key` is the case-folded
-- match key for tags, mirroring `aliases.alias_key` — folding happens in TS
-- (Unicode-aware) because SQLite's lower() only folds ASCII, so `#Café` and
-- `#café` would otherwise be different tags. Rows written before this
-- migration carry the defaults until the projection-version rebuild
-- re-indexes them (see `syncIndex` in @reflect/core).

ALTER TABLE notes ADD COLUMN preview TEXT NOT NULL DEFAULT '';
ALTER TABLE tags ADD COLUMN tag_key TEXT NOT NULL DEFAULT '';
DROP INDEX tags_tag;
CREATE INDEX tags_tag_key ON tags(tag_key);
