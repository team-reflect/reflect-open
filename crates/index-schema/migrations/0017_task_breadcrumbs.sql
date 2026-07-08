-- Parent outline/list item text for a task, encoded as a JSON string array.
-- Rebuildable projection data: the TS projection version bump reindexes notes
-- so existing rows get their real breadcrumbs instead of this empty default.
ALTER TABLE tasks ADD COLUMN breadcrumbs TEXT NOT NULL DEFAULT '[]';
