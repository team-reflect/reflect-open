-- Plan 17: the frontmatter `id` becomes real — written at creation, so the
-- column needs an index for id→path lookups and the duplicate-id check (two
-- paths claiming one id = a sync fork, surfaced for review). Partial: legacy
-- rows stay NULL until the 17c migration stamps them. Deliberately NOT
-- unique — a sync fork is a state to detect and surface, not a constraint
-- violation that would wedge indexing.
CREATE INDEX notes_id ON notes(id) WHERE id IS NOT NULL;
