-- Remember where path-dependent Markdown references were last projected.
-- A rename carries vectors and other rows forward, then the normal index
-- pipeline must reproject even when the file's bytes and mtime are unchanged.
ALTER TABLE notes ADD COLUMN projection_path TEXT NOT NULL DEFAULT '';
-- Existing asset references may already have moved under an older writer.
-- Reproject those once; notes without attachments keep their current projection.
UPDATE notes SET projection_path = path
WHERE NOT EXISTS (SELECT 1 FROM assets WHERE assets.note_path = notes.path);
