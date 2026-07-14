-- Arbitrary-vault link resolution. Paths and basenames are derived in the
-- TypeScript projection (Unicode case folding is not delegated to SQLite), and
-- every link may carry one or two exact path candidates. The alternate exists
-- only for an unqualified Markdown href that could mean source-relative or
-- vault-root-relative; backlinks resolve it only when exactly one candidate
-- exists.

DROP VIEW backlinks;
DROP VIEW note_keys;

ALTER TABLE notes ADD COLUMN path_key TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN basename_key TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN authored_title_key TEXT;
ALTER TABLE links ADD COLUMN path_key TEXT;
ALTER TABLE links ADD COLUMN alternate_path_key TEXT;

CREATE INDEX notes_path_key ON notes(path_key);
CREATE INDEX notes_basename_key ON notes(basename_key);
CREATE INDEX notes_authored_title_key ON notes(authored_title_key)
  WHERE authored_title_key IS NOT NULL;
CREATE INDEX links_path_key ON links(path_key) WHERE path_key IS NOT NULL;
CREATE INDEX links_alternate_path_key ON links(alternate_path_key)
  WHERE alternate_path_key IS NOT NULL;

-- Resolution precedence for a bare wiki target. Keeping the priority in the
-- view makes every resolver/backlink consumer share the same ordering:
-- calendar date, authored title, alias, then filename stem.
CREATE VIEW note_keys AS
  SELECT path AS note_path, daily_date AS key, 1 AS priority
    FROM notes WHERE kind != 'template' AND daily_date IS NOT NULL
  UNION ALL
  SELECT path AS note_path, authored_title_key AS key, 2 AS priority
    FROM notes WHERE kind != 'template' AND authored_title_key IS NOT NULL
  UNION ALL
  SELECT aliases.note_path, aliases.alias_key AS key, 3 AS priority
    FROM aliases
    JOIN notes ON notes.path = aliases.note_path AND notes.kind != 'template'
  UNION ALL
  SELECT path AS note_path, basename_key AS key, 4 AS priority
    FROM notes WHERE kind != 'template';

CREATE VIEW backlinks AS
  WITH
  path_candidates AS (
    SELECT links.rowid AS link_rowid, notes.path AS target_path
      FROM links
      JOIN notes ON notes.path_key = links.path_key AND notes.kind != 'template'
      WHERE links.path_key IS NOT NULL
    UNION
    SELECT links.rowid AS link_rowid, notes.path AS target_path
      FROM links
      JOIN notes ON notes.path_key = links.alternate_path_key AND notes.kind != 'template'
      WHERE links.alternate_path_key IS NOT NULL
  ),
  counted_path_candidates AS (
    SELECT link_rowid, target_path,
      count(*) OVER (PARTITION BY link_rowid) AS match_count
    FROM path_candidates
  ),
  ranked_key_candidates AS (
    SELECT links.rowid AS link_rowid, note_keys.note_path AS target_path,
      note_keys.priority,
      min(note_keys.priority) OVER (PARTITION BY links.rowid) AS best_priority
    FROM links
    JOIN note_keys ON note_keys.key = links.target_key
    WHERE links.kind = 'wiki' AND links.path_key IS NULL
  ),
  resolved AS (
    SELECT link_rowid, target_path
      FROM counted_path_candidates WHERE match_count = 1
    UNION ALL
    SELECT link_rowid, target_path
      FROM ranked_key_candidates WHERE priority = best_priority
  )
  SELECT resolved.target_path, links.source_path, links.kind, links.target_raw,
    links.alias, links.pos_from, links.pos_to
  FROM resolved
  JOIN links ON links.rowid = resolved.link_rowid
  JOIN notes source ON source.path = links.source_path AND source.kind != 'template';

-- All new values are derived from Markdown and existing paths. Clear only the
-- rebuildable projection so the next open reindexes unchanged files; durable
-- chat_* history and index_meta bookkeeping are deliberately untouched.
DELETE FROM note_text;
DELETE FROM links;
DELETE FROM tags;
DELETE FROM aliases;
DELETE FROM assets;
DELETE FROM tasks;
DELETE FROM note_emails;
DELETE FROM notes;
DELETE FROM search_fts;
