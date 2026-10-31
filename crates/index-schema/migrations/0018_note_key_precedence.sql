-- One folded wiki-link key must resolve to one note, with the same precedence
-- as the TypeScript and CLI resolvers: calendar-valid daily date, then title,
-- then alias; collisions within a tier choose the first path alphabetically.
-- Previously
-- `note_keys` exposed every claimant, so `backlinks` fanned one `[[Dad]]` link
-- out to both a note titled `Dad` and another note aliased to `Dad` even though
-- clicking the link opened only the titled note.
--
-- `note_keys` is the resolved address map, not a list of every claim: it has
-- exactly one winning note path per folded key. `claim_count` records how many
-- distinct notes claim the winning tier, so writable navigation/autocomplete
-- can refuse ambiguous spellings without changing deterministic
-- read-only resolution and backlinks. It is filtered by both key and note path,
-- so keep both directions indexed. No projection rows need rebuilding.
CREATE INDEX aliases_note_key ON aliases(note_path, alias_key);

DROP VIEW backlinks;
DROP VIEW note_keys;

CREATE VIEW note_keys AS
  -- Daily date: first path wins within the highest-precedence tier.
  SELECT
    daily.path AS note_path,
    daily.daily_date AS key,
    (
      SELECT count(*)
      FROM notes daily_claim
      WHERE daily_claim.daily_date = daily.daily_date
        AND date(daily_claim.daily_date) = daily_claim.daily_date
    ) AS claim_count
  FROM notes daily
  WHERE daily.daily_date IS NOT NULL
    AND date(daily.daily_date) = daily.daily_date
    AND NOT EXISTS (
      SELECT 1
      FROM notes better_daily
      WHERE better_daily.daily_date = daily.daily_date
        AND date(better_daily.daily_date) = better_daily.daily_date
        AND better_daily.path < daily.path
    )

  UNION ALL

  -- Title: only when no daily claims the key, then first path wins.
  SELECT
    titled.path AS note_path,
    titled.title_key AS key,
    (
      SELECT count(*)
      FROM notes title_claim
      WHERE title_claim.kind != 'template'
        AND title_claim.title_key = titled.title_key
    ) AS claim_count
  FROM notes titled
  WHERE titled.kind != 'template'
    AND NOT EXISTS (
      SELECT 1
      FROM notes daily
      WHERE daily.daily_date = titled.title_key
        AND date(daily.daily_date) = daily.daily_date
    )
    AND NOT EXISTS (
      SELECT 1
      FROM notes better_title
      WHERE better_title.kind != 'template'
        AND better_title.title_key = titled.title_key
        AND better_title.path < titled.path
    )

  UNION ALL

  -- Alias: only when neither stronger tier claims the key, then first path
  -- wins. A note can project the same folded alias more than once; rowid keeps
  -- one physical row without making projection data durable.
  SELECT
    aliased.note_path,
    aliased.alias_key AS key,
    (
      SELECT count(DISTINCT alias_claim.note_path)
      FROM aliases alias_claim
      JOIN notes alias_owner
        ON alias_owner.path = alias_claim.note_path
       AND alias_owner.kind != 'template'
      WHERE alias_claim.alias_key = aliased.alias_key
    ) AS claim_count
  FROM aliases aliased
  JOIN notes owner ON owner.path = aliased.note_path AND owner.kind != 'template'
  WHERE NOT EXISTS (
      SELECT 1
      FROM notes daily
      WHERE daily.daily_date = aliased.alias_key
        AND date(daily.daily_date) = daily.daily_date
    )
    AND NOT EXISTS (
      SELECT 1
      FROM notes titled
      WHERE titled.kind != 'template'
        AND titled.title_key = aliased.alias_key
    )
    AND NOT EXISTS (
      SELECT 1
      FROM aliases better_alias
      JOIN notes better_owner
        ON better_owner.path = better_alias.note_path
       AND better_owner.kind != 'template'
      WHERE better_alias.alias_key = aliased.alias_key
        AND better_alias.note_path < aliased.note_path
    )
    AND aliased.rowid = (
      SELECT min(duplicate.rowid)
      FROM aliases duplicate
      WHERE duplicate.alias_key = aliased.alias_key
        AND duplicate.note_path = aliased.note_path
    );

CREATE VIEW backlinks AS
  SELECT k.note_path AS target_path, l.source_path, l.kind, l.target_raw, l.alias, l.pos_from, l.pos_to
  FROM links l JOIN note_keys k ON k.key = l.target_key
  JOIN notes source ON source.path = l.source_path AND source.kind != 'template'
  WHERE l.kind = 'wiki';
