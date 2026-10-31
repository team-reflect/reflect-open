-- Name fallback for ambiguous wiki-link targets.
--
-- A non-rooted slashed wiki target (`[[john/sally meeting notes]]`) carries
-- two readings: an exact file and a note title. The resolvers try the file
-- first and fall back to the folded name; this view must mirror that order,
-- or a link that opens a note would show no backlink on it.
--
-- The projection (v19) stores the classification alongside the link:
-- `target_path_key` is the exact-file reading, and a wiki `target_key` is
-- the classifier's name reading ('' when the target has none, i.e. a rooted
-- path, a bare `#heading`, or a refused URI). A row with both keys is the
-- ambiguous form; the view applies exact-file-first between them.

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
  WHERE l.target_path_key IS NOT NULL;
