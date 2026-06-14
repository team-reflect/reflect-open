-- Tag-filtered note lists and search filters need to move quickly from a
-- folded tag key to candidate note paths. The previous single-column indexes
-- made correlated tag predicates probe by note_path, then check tag_key row by
-- row; this covering index supports both `tag_key = ? AND note_path = ?` and
-- tag-first joins.

CREATE INDEX tags_tag_key_note_path ON tags(tag_key, note_path);

-- The All Notes and filter recall feeds are newest-first over daily/non-daily
-- slices. Keep the existing single-column `notes_daily_date` index for narrow
-- date lookups; this one covers the ordered note-list path.

CREATE INDEX notes_daily_date_mtime_path ON notes(daily_date, mtime DESC, path);
