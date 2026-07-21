-- A calendar-valid `[[YYYY-MM-DD]]` addresses its lazy daily route even before
-- that day's Markdown file exists. The previous view could only expose a
-- backlink after the target appeared in `note_keys`, while opening an empty day
-- deliberately does not create its file. Synthesize that one unresolved target
-- path until a real note claims the key; once one does, `note_keys` applies the
-- usual daily > title > alias precedence in the first branch.
DROP VIEW backlinks;

CREATE VIEW backlinks AS
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw, l.alias, l.pos_from, l.pos_to
  FROM links l JOIN note_keys k ON k.key = l.target_key
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki'

  UNION ALL

  SELECT
    'daily/' || l.target_key || '.md' AS target_path,
    l.source_path,
    l.kind,
    l.target_raw,
    l.alias,
    l.pos_from,
    l.pos_to
  FROM links l
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki'
    AND length(l.target_key) = 10
    AND substr(l.target_key, 5, 1) = '-'
    AND substr(l.target_key, 8, 1) = '-'
    AND date(l.target_key) = l.target_key
    AND NOT EXISTS (
      SELECT 1 FROM note_keys k WHERE k.key = l.target_key
    );
