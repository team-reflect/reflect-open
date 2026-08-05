-- Name fallback for ambiguous wiki-link targets.
--
-- A non-rooted slashed wiki target (`[[john/sally meeting notes]]`) carries
-- two readings: an exact file and a note title. The resolvers try the file
-- first and fall back to the folded name; this view must mirror that order,
-- or a link that opens a note would show no backlink on it. `links` rows
-- already store both keys (`target_key` is projected for every wiki link),
-- so this is a view-only change: no reprojection.

DROP VIEW backlinks;

CREATE VIEW backlinks AS
  -- Name-addressed wiki links resolve through the ranked key map. A wiki
  -- link that also spells a path joins here only when that path matches no
  -- note, mirroring the resolver's exact-file-first order.
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN note_keys k ON k.key = l.target_key
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki'
    AND (l.target_path_key IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM notes t
        WHERE t.path_key = l.target_path_key AND t.kind != 'template'
      ))

  UNION ALL

  -- Path-addressed links (wiki or Markdown) name exactly one file, so they
  -- need no ranking. A path that matches nothing produces no row here; a
  -- wiki link falls back to the name branch above instead.
  SELECT t.path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN notes t ON t.path_key = l.target_path_key AND t.kind != 'template'
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.target_path_key IS NOT NULL;
