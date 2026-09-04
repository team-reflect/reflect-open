-- Remember where path-dependent Markdown references were last projected.
-- A rename carries vectors and other rows forward, then the normal index
-- pipeline must reproject even when the file's bytes and mtime are unchanged.
ALTER TABLE notes ADD COLUMN projection_path TEXT NOT NULL DEFAULT '';
-- Reproject existing local notes once: older renames may have changed even
-- previously unresolved references, so the old asset rows cannot identify them.
-- Evicted notes retain this marker until their content becomes local.
