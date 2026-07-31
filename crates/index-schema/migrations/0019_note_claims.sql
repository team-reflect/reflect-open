-- Note addressing for arbitrary vaults.
--
-- Two things a link can name were previously unrepresentable: an exact file
-- (`[[Projects/Plan]]`, `[Plan](./Plan.md)`) and a filename stem for a note
-- whose authored title differs from its filename (`[[Plan]]` opening
-- `Projects/Plan.md` titled "Weekly Planning", which is how Obsidian
-- addresses every note).
--
-- `note_keys` used to derive precedence at query time, unioning tiers out of
-- `notes` and `aliases` and cross-checking them with NOT EXISTS, so every new
-- tier squared the work. Which spellings a note answers to is a per-note
-- fact, so the projection now writes them like it already writes tags and
-- aliases (`note_claims`), and the view is left with the resolution rule
-- alone: strongest tier wins, first path wins inside it. Calendar validity
-- moves to the projection too: an impossible `daily/2026-02-31.md` never
-- claims tier 1, so the view needs no `date()` guard.

CREATE TABLE note_claims (
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  -- 1 calendar-valid daily date, 2 authored title, 3 alias, 4 filename stem.
  tier      INTEGER NOT NULL,
  -- The primary key is also the lookup index, and it collapses a note that
  -- projects one folded spelling twice (aliases differing only by case).
  PRIMARY KEY (key, tier, note_path)
) WITHOUT ROWID;

-- Suggestion verification asks the opposite question: which spellings does
-- this note win? Index that direction too.
CREATE INDEX note_claims_note ON note_claims(note_path, key);

-- Exact-file addressing. Folded in TypeScript with the same ASCII rule the
-- Rust walker uses, so one file is one key on every platform.
ALTER TABLE notes ADD COLUMN path_key TEXT NOT NULL DEFAULT '';
ALTER TABLE links ADD COLUMN target_path_key TEXT;
CREATE INDEX notes_path_key ON notes(path_key);
CREATE INDEX links_target_path_key ON links(target_path_key)
  WHERE target_path_key IS NOT NULL;

DROP VIEW backlinks;
DROP VIEW note_keys;

-- One winning note per key. `claim_count` is how many notes claim the winning
-- tier, so writable navigation and autocomplete can refuse a spelling that
-- would be a coin flip without changing deterministic read resolution.
CREATE VIEW note_keys AS
  SELECT
    winner.note_path,
    winner.key,
    (
      SELECT count(*) FROM note_claims peer
      WHERE peer.key = winner.key AND peer.tier = winner.tier
    ) AS claim_count
  FROM note_claims winner
  WHERE winner.tier = (
      SELECT min(best.tier) FROM note_claims best WHERE best.key = winner.key
    )
    AND winner.note_path = (
      SELECT min(first.note_path) FROM note_claims first
      WHERE first.key = winner.key AND first.tier = winner.tier
    );

CREATE VIEW backlinks AS
  -- Name-addressed wiki links resolve through the ranked key map. Templates
  -- claim nothing, so the target side needs no filter of its own.
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN note_keys k ON k.key = l.target_key
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki' AND l.target_path_key IS NULL

  UNION ALL

  -- Path-addressed links (wiki or Markdown) name exactly one file, so they
  -- need no ranking. A path that matches nothing produces no backlink.
  SELECT t.path AS target_path, l.source_path, l.kind, l.target_raw,
         l.alias, l.pos_from, l.pos_to
  FROM links l
  JOIN notes t ON t.path_key = l.target_path_key AND t.kind != 'template'
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.target_path_key IS NOT NULL;
