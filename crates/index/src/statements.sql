-- index_apply
DELETE FROM "notes"
  WHERE "path" = ?;
DELETE FROM "search_fts"
  WHERE "path" = ?;
INSERT INTO "notes" ("path", "id", "title", "title_key", "path_key", "kind", "daily_date", "is_private", "is_pinned", "pinned_order", "gist_url", "gist_stale", "file_hash", "mtime", "updated_at", "preview", "has_content")
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
INSERT INTO "links" ("source_path", "kind", "target_raw", "target_key", "target_path_key", "alias", "pos_from", "pos_to")
  VALUES (?, ?, ?, ?, ?, ?, ?, ?);
INSERT INTO "tags" ("note_path", "tag", "tag_key")
  VALUES (?, ?, ?);
INSERT INTO "aliases" ("note_path", "alias", "alias_key")
  VALUES (?, ?, ?);
INSERT INTO "note_claims" ("note_path", "key", "tier")
  VALUES (?, ?, ?);
INSERT INTO "note_emails" ("note_path", "email", "email_key")
  VALUES (?, ?, ?);
INSERT INTO "assets" ("note_path", "asset_path")
  VALUES (?, ?);
INSERT INTO "tasks" ("note_path", "ast_path", "markdown", "breadcrumbs", "checked", "due_date")
  VALUES (?, ?, ?, ?, ?, ?);
INSERT INTO "search_fts" ("path", "title", "body")
  VALUES (?, ?, ?);

-- index_apply_batch
DELETE FROM "notes"
  WHERE "path" = ?;
DELETE FROM "search_fts"
  WHERE "path" = ?;
INSERT INTO "notes" ("path", "id", "title", "title_key", "path_key", "kind", "daily_date", "is_private", "is_pinned", "pinned_order", "gist_url", "gist_stale", "file_hash", "mtime", "updated_at", "preview", "has_content")
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
INSERT INTO "links" ("source_path", "kind", "target_raw", "target_key", "target_path_key", "alias", "pos_from", "pos_to")
  VALUES (?, ?, ?, ?, ?, ?, ?, ?);
INSERT INTO "tags" ("note_path", "tag", "tag_key")
  VALUES (?, ?, ?);
INSERT INTO "aliases" ("note_path", "alias", "alias_key")
  VALUES (?, ?, ?);
INSERT INTO "note_claims" ("note_path", "key", "tier")
  VALUES (?, ?, ?);
INSERT INTO "note_emails" ("note_path", "email", "email_key")
  VALUES (?, ?, ?);
INSERT INTO "assets" ("note_path", "asset_path")
  VALUES (?, ?);
INSERT INTO "tasks" ("note_path", "ast_path", "markdown", "breadcrumbs", "checked", "due_date")
  VALUES (?, ?, ?, ?, ?, ?);
INSERT INTO "search_fts" ("path", "title", "body")
  VALUES (?, ?, ?);

-- index_touch
UPDATE "notes"
  SET "mtime" = ?, "updated_at" = ?
  WHERE "path" = ?;

-- index_meta_set
INSERT INTO "index_meta" ("key", "value")
  VALUES (?, ?)
  ON CONFLICT ("key") DO UPDATE
  SET "value" = "excluded"."value";

-- chat_message_save
INSERT INTO "chat_conversations" ("id", "title", "created_ms", "updated_ms")
  VALUES (?, ?, ?, ?)
  ON CONFLICT ("id") DO UPDATE
  SET "updated_ms" = "excluded"."updated_ms";
INSERT INTO "chat_messages" ("id", "conversation_id", "seq", "user_text", "attachments", "parts", "response_messages", "created_ms")
  VALUES (?, ?, (SELECT COALESCE(MAX("seq") + 1, 0)
      FROM "chat_messages"
      WHERE "conversation_id" = ?), ?, ?, ?, ?, ?)
  ON CONFLICT ("id") DO UPDATE
  SET "user_text" = "excluded"."user_text", "attachments" = "excluded"."attachments", "parts" = "excluded"."parts", "response_messages" = "excluded"."response_messages";

-- embed_apply: new chunks
SELECT EXISTS(SELECT 1
    FROM "notes"
    WHERE "path" = ?);
SELECT "id", "content_hash"
  FROM "embedding_chunks"
  WHERE "note_path" = ?
  ORDER BY "pos_from" ASC;
INSERT INTO "embedding_chunks" ("note_path", "heading", "pos_from", "pos_to", "text", "content_hash", "model_id")
  VALUES (?, ?, ?, ?, ?, ?, ?);
INSERT INTO "embedding_vectors" ("rowid", "embedding")
  VALUES (?, ?);

-- embed_apply: a kept chunk and a stale chunk
SELECT EXISTS(SELECT 1
    FROM "notes"
    WHERE "path" = ?);
SELECT "id", "content_hash"
  FROM "embedding_chunks"
  WHERE "note_path" = ?
  ORDER BY "pos_from" ASC;
UPDATE "embedding_chunks"
  SET "heading" = ?, "pos_from" = ?, "pos_to" = ?, "model_id" = ?
  WHERE "id" = ?;
DELETE FROM "embedding_vectors"
  WHERE "rowid" = ?;
DELETE FROM "embedding_chunks"
  WHERE "id" = ?;

-- index_meta_get
SELECT "value"
  FROM "index_meta"
  WHERE "key" = ?;

-- index_graph_stats
SELECT COUNT(*)
  FROM "notes"
  WHERE "kind" = 'note'
  AND "is_private" = 0;
SELECT COUNT(*), MIN("daily_date"), MAX("daily_date")
  FROM "notes"
  WHERE "daily_date" IS NOT NULL
  AND "is_private" = 0;
SELECT MIN("tags"."tag"), COUNT(*)
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "notes"."kind" = 'note'
  AND "notes"."is_private" = 0
  GROUP BY "tags"."tag_key"
  ORDER BY COUNT(*) DESC, "tags"."tag_key" ASC
  LIMIT ?;

-- index_note
SELECT "path", "title", "daily_date", "is_private", "gist_url", "gist_stale"
  FROM "notes"
  WHERE "path" = ?;

-- index_pinned_notes
SELECT "path", "title", "daily_date", "pinned_order"
  FROM "notes"
  WHERE "is_pinned" = 1
  AND "kind" <> 'template'
  ORDER BY "pinned_order" IS NULL ASC, "pinned_order" ASC, "title_key" ASC, "path" ASC;

-- index_templates
SELECT "path", "title", "mtime"
  FROM "notes"
  WHERE "kind" = 'template'
  ORDER BY "title_key" ASC, "path" ASC;

-- index_file_facts
SELECT "path", "file_hash", "mtime"
  FROM "notes"
  WHERE "path" IN (SELECT "value"
    FROM json_each(?) AS "json_each");

-- index_note_ids
SELECT "path", "id"
  FROM "notes"
  WHERE "path" IN (SELECT "value"
    FROM json_each(?) AS "json_each");

-- index_note_privacy
SELECT "path", "is_private"
  FROM "notes"
  WHERE "path" IN (SELECT "value"
    FROM json_each(?) AS "json_each");

-- index_random_note
SELECT "path"
  FROM "notes"
  ORDER BY RANDOM() ASC
  LIMIT ?;

-- index_resolve_target: no match, every lookup runs
SELECT "path"
  FROM "notes"
  WHERE "id" = ?
  ORDER BY "path" ASC
  LIMIT ?;
SELECT "path"
  FROM "notes"
  WHERE "path" = ?
  ORDER BY "path" ASC
  LIMIT ?;
SELECT "path"
  FROM "notes"
  WHERE "title_key" = ?
  ORDER BY "path" ASC
  LIMIT ?;
SELECT "note_path"
  FROM "aliases"
  WHERE "alias_key" = ?
  ORDER BY "note_path" ASC
  LIMIT ?;

-- index_path_taken
SELECT EXISTS(SELECT 1
    FROM "notes"
    WHERE "path" = ?);

-- index_asset_owners
SELECT DISTINCT "note_path"
  FROM "assets"
  WHERE "asset_path" IN (SELECT "value"
    FROM json_each(?) AS "json_each");

-- index_person_owners
SELECT DISTINCT "notes"."path"
  FROM "note_emails"
  INNER JOIN "notes" ON "notes"."path" = "note_emails"."note_path"
  INNER JOIN "tags" ON "tags"."note_path" = "notes"."path"
  WHERE "note_emails"."email_key" IN (SELECT "value"
    FROM json_each(?) AS "json_each")
  AND "tags"."tag_key" = ?
  AND "notes"."kind" = 'note'
  ORDER BY "notes"."path" ASC;

-- index_embeddable_paths
SELECT "path"
  FROM "notes"
  WHERE "kind" <> 'template'
  ORDER BY "path" ASC;

-- index_list_notes: every note
SELECT "notes"."path", "notes"."title", "notes"."mtime", "notes"."preview", "notes"."is_pinned"
  FROM "notes"
  WHERE "notes"."kind" = 'note'
  ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC;
SELECT "tags"."note_path", "tags"."tag"
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "notes"."kind" = 'note'
  ORDER BY "tags"."tag_key" ASC;

-- index_list_notes: one tag
SELECT DISTINCT "notes"."path", "notes"."title", "notes"."mtime", "notes"."preview", "notes"."is_pinned", "notes"."pinned_order"
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "tags"."tag_key" = ?
  AND "notes"."kind" IN ('note', 'daily')
  ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC;
SELECT DISTINCT "tags"."note_path", "tags"."tag"
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  INNER JOIN "tags" AS "filter_tags" ON "filter_tags"."note_path" = "notes"."path"
  WHERE "filter_tags"."tag_key" = ?
  AND "notes"."kind" IN ('note', 'daily')
  ORDER BY "tags"."tag_key" ASC;

-- index_recent_notes: every note
SELECT "notes"."path", "notes"."title", "notes"."preview", "notes"."mtime", "notes"."is_private"
  FROM "notes"
  WHERE "notes"."kind" = 'note'
  AND "notes"."is_private" = 0
  ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
  LIMIT ?;

-- index_recent_notes: one tag
SELECT DISTINCT "notes"."path", "notes"."title", "notes"."preview", "notes"."mtime", "notes"."is_private"
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "tags"."tag_key" = ?
  AND "notes"."kind" = 'note'
  AND "notes"."is_private" = 0
  ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
  LIMIT ?;

-- index_note_tags
SELECT MIN("tags"."tag"), COUNT(*)
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "notes"."kind" = 'note'
  GROUP BY "tags"."tag_key"
  ORDER BY "tags"."tag_key" ASC;

-- index_tasks: open
SELECT "tasks"."note_path", "tasks"."ast_path", "tasks"."markdown", "tasks"."breadcrumbs", "tasks"."checked", "notes"."title", "notes"."daily_date", "notes"."is_pinned", "notes"."pinned_order", "notes"."updated_at"
  FROM "tasks"
  INNER JOIN "notes" ON "notes"."path" = "tasks"."note_path"
  WHERE "notes"."kind" <> 'template'
  AND "tasks"."checked" = 0;

-- index_tasks: completed
SELECT "tasks"."note_path", "tasks"."ast_path", "tasks"."markdown", "tasks"."breadcrumbs", "tasks"."checked", "notes"."title", "notes"."daily_date", "notes"."is_pinned", "notes"."pinned_order", "notes"."updated_at"
  FROM "tasks"
  INNER JOIN "notes" ON "notes"."path" = "tasks"."note_path"
  WHERE "notes"."kind" <> 'template'
  AND "tasks"."checked" = 1;

-- index_daily_dates
SELECT "daily_date"
  FROM "notes"
  WHERE "daily_date" IS NOT NULL
  AND "daily_date" >= ?
  AND "daily_date" <= ?
  AND "has_content" = 1
  ORDER BY "daily_date" ASC;

-- index_daily_notes
SELECT "path", "title", "daily_date", "preview", "mtime", "is_private"
  FROM "notes"
  WHERE "daily_date" IS NOT NULL
  AND "daily_date" >= ?
  AND "daily_date" <= ?
  AND "is_private" = 0
  ORDER BY "daily_date" DESC
  LIMIT ?;

-- index_resolve_wiki
SELECT "note_path"
  FROM "note_keys"
  WHERE "key" = ?
  LIMIT ?;

-- index_wiki_target_match
SELECT DISTINCT "note_path", "tier"
  FROM "note_claims"
  WHERE "key" = ?
  AND "tier" = (SELECT MIN("tier")
    FROM "note_claims"
    WHERE "key" = ?)
  ORDER BY "note_path" ASC;

-- index_notes_by_path_key
SELECT DISTINCT "path"
  FROM "notes"
  WHERE "path_key" = ?
  ORDER BY "path" ASC;

-- index_link_sources
SELECT DISTINCT "source_path"
  FROM "links"
  WHERE "target_key" = ?
  ORDER BY "source_path" ASC;

-- index_path_link_sources
SELECT DISTINCT "source_path"
  FROM "links"
  WHERE "target_path_key" = ?
  ORDER BY "source_path" ASC;

-- index_wiki_address_note
SELECT "path", "title", "title_key", "daily_date", "mtime"
  FROM "notes"
  WHERE "path" = ?
  AND "kind" <> 'template';

-- index_backlinks
SELECT "source_path", "target_raw", "alias", "pos_from", "pos_to"
  FROM "backlinks"
  WHERE "target_path" = ?
  ORDER BY "source_path" ASC;

-- index_backlink_page: the first page
SELECT "key"
  FROM "note_keys"
  WHERE "note_path" = ?
  AND "key" IS NOT NULL;
SELECT DISTINCT "source_path", "source_title", "recency"
  FROM (SELECT "backlinks"."source_path" AS "source_path", "notes"."title" AS "source_title", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
    FROM "backlinks"
    INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
    WHERE "backlinks"."target_path" = ?) AS "sources"
  WHERE TRUE
  ORDER BY "recency" DESC, "source_path" ASC
  LIMIT ?;
SELECT COUNT(*)
  FROM "backlinks"
  INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
  WHERE "backlinks"."target_path" = ?;
SELECT "source_path", "pos_from"
  FROM (SELECT "backlinks"."source_path" AS "source_path", "backlinks"."pos_from" AS "pos_from", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
    FROM "backlinks"
    INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
    WHERE "backlinks"."target_path" = ?) AS "sources"
  WHERE "recency" > ?
  OR ("recency" = ?
    AND "source_path" <= ?)
  ORDER BY "recency" DESC, "source_path" ASC, "pos_from" ASC;

-- index_backlink_page: after a cursor
SELECT "key"
  FROM "note_keys"
  WHERE "note_path" = ?
  AND "key" IS NOT NULL;
SELECT DISTINCT "source_path", "source_title", "recency"
  FROM (SELECT "backlinks"."source_path" AS "source_path", "notes"."title" AS "source_title", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
    FROM "backlinks"
    INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
    WHERE "backlinks"."target_path" = ?) AS "sources"
  WHERE "recency" < ?
  OR ("recency" = ?
    AND "source_path" > ?)
  ORDER BY "recency" DESC, "source_path" ASC
  LIMIT ?;
SELECT COUNT(*)
  FROM "backlinks"
  INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
  WHERE "backlinks"."target_path" = ?;
SELECT "source_path", "pos_from"
  FROM (SELECT "backlinks"."source_path" AS "source_path", "backlinks"."pos_from" AS "pos_from", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
    FROM "backlinks"
    INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
    WHERE "backlinks"."target_path" = ?) AS "sources"
  WHERE ("recency" < ?
    OR ("recency" = ?
      AND "source_path" > ?))
  AND ("recency" > ?
    OR ("recency" = ?
      AND "source_path" <= ?))
  ORDER BY "recency" DESC, "source_path" ASC, "pos_from" ASC;

-- index_suggest_tags: every tag
SELECT MIN("tags"."tag"), COUNT(*)
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "notes"."kind" <> 'template'
  GROUP BY "tags"."tag_key"
  ORDER BY COUNT(*) DESC, MIN("tags"."tag") ASC
  LIMIT ?;

-- index_suggest_tags: a tag key
SELECT MIN("tags"."tag"), COUNT(*)
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "notes"."kind" <> 'template'
  AND "tags"."tag_key" LIKE ? ESCAPE '\'
  GROUP BY "tags"."tag_key"
  ORDER BY COUNT(*) DESC, MIN("tags"."tag") ASC
  LIMIT ?;

-- index_wiki_candidates: no key
SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", (SELECT COUNT(*)
    FROM "note_claims"
    INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
    WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  AND "notes"."daily_date" IS NULL
  ORDER BY "notes"."title_key" = ? DESC, "notes"."title_key" LIKE ? ESCAPE '\' DESC, "link_count" DESC, "notes"."mtime" DESC
  LIMIT ?;

-- index_wiki_candidates: a key
SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", (SELECT COUNT(*)
    FROM "note_claims"
    INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
    WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  AND ("notes"."title_key" LIKE ? ESCAPE '\'
    OR "notes"."path" IN (SELECT "path"
      FROM "search_fts"
      WHERE "search_fts" MATCH ?))
  ORDER BY "notes"."title_key" = ? DESC, "notes"."title_key" LIKE ? ESCAPE '\' DESC, "link_count" DESC, "notes"."mtime" DESC
  LIMIT ?;
SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", "aliases"."alias", "aliases"."alias_key", (SELECT COUNT(*)
    FROM "note_claims"
    INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
    WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
  FROM "aliases"
  INNER JOIN "notes" ON "notes"."path" = "aliases"."note_path"
  WHERE "notes"."kind" <> 'template'
  AND "aliases"."alias_key" LIKE ? ESCAPE '\'
  ORDER BY "aliases"."alias_key" = ? DESC, "link_count" DESC, "notes"."mtime" DESC
  LIMIT ?;

-- index_wiki_candidates: a key with no search term
SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", (SELECT COUNT(*)
    FROM "note_claims"
    INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
    WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  AND "notes"."title_key" LIKE ? ESCAPE '\'
  ORDER BY "notes"."title_key" = ? DESC, "notes"."title_key" LIKE ? ESCAPE '\' DESC, "link_count" DESC, "notes"."mtime" DESC
  LIMIT ?;
SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", "aliases"."alias", "aliases"."alias_key", (SELECT COUNT(*)
    FROM "note_claims"
    INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
    WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
  FROM "aliases"
  INNER JOIN "notes" ON "notes"."path" = "aliases"."note_path"
  WHERE "notes"."kind" <> 'template'
  AND "aliases"."alias_key" LIKE ? ESCAPE '\'
  ORDER BY "aliases"."alias_key" = ? DESC, "link_count" DESC, "notes"."mtime" DESC
  LIMIT ?;

-- index_wiki_key_winners
SELECT "note_keys"."key", "note_keys"."note_path", "notes"."daily_date", "note_keys"."claim_count"
  FROM "note_keys"
  INNER JOIN "notes" ON "notes"."path" = "note_keys"."note_path"
  WHERE "note_keys"."key" IN (SELECT "value"
    FROM json_each(?) AS "json_each");

-- index_wiki_winning_aliases
SELECT "aliases"."note_path", "aliases"."alias"
  FROM "aliases"
  INNER JOIN "note_keys" ON "note_keys"."key" = "aliases"."alias_key"
  AND "note_keys"."note_path" = "aliases"."note_path"
  WHERE "aliases"."note_path" IN (SELECT "value"
    FROM json_each(?) AS "json_each")
  AND "note_keys"."claim_count" = 1
  ORDER BY "aliases"."rowid" ASC;

-- embed_chunk_hashes
SELECT "content_hash", "model_id"
  FROM "embedding_chunks"
  WHERE "note_path" = ?;

-- embed_related_chunks
SELECT vec_to_json("embedding_vectors"."embedding")
  FROM "embedding_chunks"
  INNER JOIN "embedding_vectors" ON "embedding_vectors"."rowid" = "embedding_chunks"."id"
  WHERE "embedding_chunks"."note_path" = ?
  ORDER BY "embedding_chunks"."pos_from" ASC
  LIMIT ?;
SELECT "embedding_chunks"."note_path", "notes"."title", "embedding_chunks"."heading", "embedding_chunks"."text", "notes"."is_private", "embedding_vectors"."distance"
  FROM "embedding_vectors"
  INNER JOIN "embedding_chunks" ON "embedding_chunks"."id" = "embedding_vectors"."rowid"
  INNER JOIN "notes" ON "notes"."path" = "embedding_chunks"."note_path"
  WHERE ("embedding_vectors"."embedding" MATCH ?)
  AND "embedding_vectors"."k" = ?
  AND "notes"."is_private" = 0
  ORDER BY "embedding_vectors"."distance" ASC;

-- embed_semantic_chunks
SELECT "embedding_chunks"."note_path", "notes"."title", "embedding_chunks"."heading", "embedding_chunks"."text", "notes"."is_private", "embedding_vectors"."distance"
  FROM "embedding_vectors"
  INNER JOIN "embedding_chunks" ON "embedding_chunks"."id" = "embedding_vectors"."rowid"
  INNER JOIN "notes" ON "notes"."path" = "embedding_chunks"."note_path"
  WHERE ("embedding_vectors"."embedding" MATCH ?)
  AND "embedding_vectors"."k" = ?
  ORDER BY "embedding_vectors"."distance" ASC;

-- index_search: no text, no filter
SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  ORDER BY "notes"."mtime" DESC, "notes"."path" ASC;

-- index_search: no text, pins first
SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC
  LIMIT ?;

-- index_search: no text, daily notes
SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
  FROM "notes"
  WHERE "notes"."kind" <> 'template'
  AND "notes"."daily_date" IS NOT NULL
  ORDER BY "notes"."mtime" DESC, "notes"."path" ASC;

-- index_search: no text, every filter
SELECT DISTINCT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
  FROM "tags"
  INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
  WHERE "tags"."tag_key" = ?
  AND "notes"."kind" <> 'template'
  AND EXISTS(SELECT 1
    FROM "tags" AS "filter_tags"
    WHERE "filter_tags"."note_path" = "notes"."path"
    AND "filter_tags"."tag_key" = ?)
  AND "notes"."kind" = 'note'
  AND "notes"."is_pinned" = 1
  AND EXISTS(SELECT 1
    FROM "backlinks"
    WHERE "backlinks"."source_path" = "notes"."path"
    AND "backlinks"."target_path" = ?)
  AND EXISTS(SELECT 1
    FROM "backlinks"
    WHERE "backlinks"."target_path" = "notes"."path"
    AND "backlinks"."source_path" = ?)
  AND "notes"."mtime" >= ?
  AND "notes"."mtime" < ?
  ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC
  LIMIT ?;

-- index_search: text
WITH "lexical" AS  MATERIALIZED (SELECT "search_fts"."path" AS "path", highlight("search_fts", 1, ?, ?) AS "fts_highlighted_title", snippet("search_fts", 2, ?, ?, '…', 10) AS "snippet", bm25("search_fts", 0, 10, 1) AS "rank"
    FROM "search_fts"
    WHERE "search_fts" MATCH ?)
  SELECT "fn"."path", "fn"."title", "fn"."daily_date", "fn"."preview", "fn"."mtime", "fn"."is_pinned", "lexical"."fts_highlighted_title", "lexical"."snippet", (CASE
    WHEN (instr(COALESCE("lexical"."snippet", ''), ?) > 0
      OR (NOT (instr(' ' || "fn"."title_key", ?) > 0
          AND instr(' ' || "fn"."title_key", ?) > 0)))
    THEN COALESCE("lexical"."rank", 0)
    ELSE 0 END) AS "score"
  FROM (SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned", "notes"."title_key"
    FROM "notes"
    WHERE "notes"."kind" <> 'template') AS "fn"
  LEFT JOIN "lexical" ON "lexical"."path" = "fn"."path"
  WHERE "lexical"."path" IS NOT NULL
  OR (instr(' ' || "fn"."title_key", ?) > 0
    AND instr(' ' || "fn"."title_key", ?) > 0)
  ORDER BY (CASE
    WHEN ("fn"."title_key" = ?)
    THEN 0
    WHEN (instr("fn"."title_key", ?) = 1)
    THEN 1
    WHEN (instr(' ' || "fn"."title_key", ?) > 0
      AND instr(' ' || "fn"."title_key", ?) > 0)
    THEN 2
    ELSE 3 END) ASC, "score" ASC, "fn"."is_pinned" DESC, "fn"."mtime" DESC, "fn"."path" ASC;

-- index_search: text, every filter
WITH "lexical" AS  MATERIALIZED (SELECT "search_fts"."path" AS "path", highlight("search_fts", 1, ?, ?) AS "fts_highlighted_title", snippet("search_fts", 2, ?, ?, '…', 10) AS "snippet", bm25("search_fts", 0, 10, 1) AS "rank"
    FROM "search_fts"
    WHERE "search_fts" MATCH ?)
  SELECT "fn"."path", "fn"."title", "fn"."daily_date", "fn"."preview", "fn"."mtime", "fn"."is_pinned", "lexical"."fts_highlighted_title", "lexical"."snippet", (CASE
    WHEN (instr(COALESCE("lexical"."snippet", ''), ?) > 0
      OR (NOT (instr(' ' || "fn"."title_key", ?) > 0
          AND instr(' ' || "fn"."title_key", ?) > 0)))
    THEN COALESCE("lexical"."rank", 0)
    ELSE 0 END) AS "score"
  FROM (SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned", "notes"."title_key"
    FROM "notes"
    WHERE "notes"."kind" <> 'template'
    AND EXISTS(SELECT 1
      FROM "tags" AS "filter_tags"
      WHERE "filter_tags"."note_path" = "notes"."path"
      AND "filter_tags"."tag_key" = ?)
    AND EXISTS(SELECT 1
      FROM "tags" AS "filter_tags"
      WHERE "filter_tags"."note_path" = "notes"."path"
      AND "filter_tags"."tag_key" = ?)
    AND "notes"."kind" = 'note'
    AND "notes"."is_pinned" = 1
    AND EXISTS(SELECT 1
      FROM "backlinks"
      WHERE "backlinks"."source_path" = "notes"."path"
      AND "backlinks"."target_path" = ?)
    AND EXISTS(SELECT 1
      FROM "backlinks"
      WHERE "backlinks"."target_path" = "notes"."path"
      AND "backlinks"."source_path" = ?)
    AND "notes"."mtime" >= ?
    AND "notes"."mtime" < ?) AS "fn"
  LEFT JOIN "lexical" ON "lexical"."path" = "fn"."path"
  WHERE "lexical"."path" IS NOT NULL
  OR (instr(' ' || "fn"."title_key", ?) > 0
    AND instr(' ' || "fn"."title_key", ?) > 0)
  ORDER BY (CASE
    WHEN ("fn"."title_key" = ?)
    THEN 0
    WHEN (instr("fn"."title_key", ?) = 1)
    THEN 1
    WHEN (instr(' ' || "fn"."title_key", ?) > 0
      AND instr(' ' || "fn"."title_key", ?) > 0)
    THEN 2
    ELSE 3 END) ASC, "score" ASC, "fn"."is_pinned" DESC, "fn"."mtime" DESC, "fn"."path" ASC
  LIMIT ?;

-- chat_conversations
SELECT "id", "title", "created_ms", "updated_ms"
  FROM "chat_conversations"
  ORDER BY "updated_ms" DESC
  LIMIT ?;

-- chat_messages
SELECT "id", "conversation_id", "user_text", "attachments", "parts", "response_messages", "created_ms"
  FROM "chat_messages"
  WHERE "conversation_id" = ?
  ORDER BY "seq" ASC;

-- search_ranked: without private notes
WITH "lexical" AS  MATERIALIZED (SELECT "search_fts"."path" AS "path", highlight("search_fts", 1, ?, ?) AS "fts_highlighted_title", snippet("search_fts", 2, ?, ?, '…', 10) AS "snippet", bm25("search_fts", 0, 10, 1) AS "rank"
    FROM "search_fts"
    WHERE "search_fts" MATCH ?)
  SELECT "fn"."path", "fn"."title", "fn"."daily_date", "fn"."preview", "fn"."mtime", "fn"."is_pinned", "lexical"."fts_highlighted_title", "lexical"."snippet", (CASE
    WHEN (instr(COALESCE("lexical"."snippet", ''), ?) > 0
      OR (NOT instr(' ' || "fn"."title_key", ?) > 0))
    THEN COALESCE("lexical"."rank", 0)
    ELSE 0 END) AS "score"
  FROM (SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned", "notes"."title_key"
    FROM "notes"
    WHERE "notes"."kind" <> 'template'
    AND "notes"."is_private" = 0) AS "fn"
  LEFT JOIN "lexical" ON "lexical"."path" = "fn"."path"
  WHERE "lexical"."path" IS NOT NULL
  OR instr(' ' || "fn"."title_key", ?) > 0
  ORDER BY (CASE
    WHEN ("fn"."title_key" = ?)
    THEN 0
    WHEN (instr("fn"."title_key", ?) = 1)
    THEN 1
    WHEN (instr(' ' || "fn"."title_key", ?) > 0)
    THEN 2
    ELSE 3 END) ASC, "score" ASC, "fn"."is_pinned" DESC, "fn"."mtime" DESC, "fn"."path" ASC;

-- reconcile_scan
SELECT "path", "mtime", "file_hash"
  FROM "notes";

-- index_move
PRAGMA defer_foreign_keys = ON;
SELECT 1
  FROM "notes"
  WHERE "path" = ?;
UPDATE "notes"
  SET "path" = ?, "path_key" = ?
  WHERE "path" = ?;
UPDATE "note_claims"
  SET "note_path" = ?
  WHERE "note_path" = ?;
DELETE FROM "note_claims"
  WHERE "note_path" = ?
  AND "tier" IN (?, ?);
INSERT INTO "note_claims" ("note_path", "key", "tier")
  SELECT ?, ?, ?
  WHERE NOT EXISTS(SELECT 1
    FROM "note_claims"
    WHERE "note_path" = ?
    AND "key" = ?);
UPDATE "links"
  SET "source_path" = ?
  WHERE "source_path" = ?;
UPDATE "tags"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "aliases"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "note_emails"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "assets"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "tasks"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "embedding_chunks"
  SET "note_path" = ?
  WHERE "note_path" = ?;
UPDATE "search_fts"
  SET "path" = ?
  WHERE "path" = ?;

-- embed_remove
DELETE FROM "embedding_vectors"
  WHERE "rowid" IN (SELECT "id"
    FROM "embedding_chunks"
    WHERE "note_path" = ?);
DELETE FROM "embedding_chunks"
  WHERE "note_path" = ?;

-- chat_conversation_delete
DELETE FROM "chat_conversations"
  WHERE "id" = ?;

-- index_remove
DELETE FROM "notes"
  WHERE "path" = ?;
DELETE FROM "search_fts"
  WHERE "path" = ?;
DELETE FROM "embedding_vectors"
  WHERE "rowid" IN (SELECT "id"
    FROM "embedding_chunks"
    WHERE "note_path" = ?);
DELETE FROM "embedding_chunks"
  WHERE "note_path" = ?;

-- index_clear
DELETE FROM "notes";
DELETE FROM "search_fts";
DELETE FROM "embedding_vectors";
DELETE FROM "embedding_chunks";

