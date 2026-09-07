-- Remember where path-dependent Markdown references were last projected.
-- A rename carries vectors and other rows forward, then the normal index
-- pipeline must reproject even when the file's bytes and mtime are unchanged.
ALTER TABLE notes ADD COLUMN projection_path TEXT NOT NULL DEFAULT '';
-- Existing rows count as projected at their current path: the projection
-- version bump that preceded this migration already rebuilt every row from
-- the file at that path, so no upgrade-time reprojection is needed.
UPDATE notes SET projection_path = path;
