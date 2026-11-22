-- Backlinks to a day whose daily note does not exist yet.
--
-- Future days are virtual notes: the file is created on first edit (Plan 06).
-- A `[[2026-11-23]]` written today, such as a task scheduled for tomorrow,
-- named no indexed note, so the day showed no backlinks until it was edited.
-- A wiki link whose name reading is an ISO date that no note claims now
-- resolves to that day's canonical path, `daily/<date>.md`. Once the note
-- exists it claims the date and the first branch resolves the link instead,
-- so no link is counted twice. A note titled or aliased with the date still
-- wins over the virtual day, as before.

DROP VIEW backlinks;

CREATE VIEW backlinks AS
  -- Name-addressed wiki links resolve through the ranked key map. A wiki
  -- link that also spells a path joins here only when that path matches no
  -- note, mirroring the resolver's exact-file-first order. A row with no
  -- name reading (target_key = '') can never join: no claim is ''.
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN note_keys k ON k.key = l.target_key
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki' AND l.target_key != ''
    AND (l.target_path_key IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM notes t
        WHERE t.path_key = l.target_path_key AND t.kind != 'template'
      ))

  UNION ALL

  -- Path-addressed links (wiki or Markdown) name exactly one file, so they
  -- need no ranking. A path that matches nothing produces no row here; a
  -- wiki link with a name reading falls back to the branch above instead.
  SELECT t.path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN notes t ON t.path_key = l.target_path_key AND t.kind != 'template'
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.target_path_key IS NOT NULL

  UNION ALL

  -- A date link to a day with no note yet: the day's virtual daily note.
  SELECT 'daily/' || l.target_key || '.md' AS target_path, l.source_path, l.kind,
         l.target_raw, l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki' AND l.target_path_key IS NULL
    AND l.target_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND NOT EXISTS (SELECT 1 FROM note_keys k WHERE k.key = l.target_key);
