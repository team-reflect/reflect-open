//! Cross-module index tests: most exercise the write path and the read
//! queries together against a migrated in-memory database, the same shape the commands
//! compose at runtime.

use expect_test::{Expect, expect};
use reflect_index_schema::LATEST_SCHEMA_VERSION;
use reflect_types::{
    ChatConversation, ChatMessageRow, EmbeddedChunk, IndexedAlias, IndexedClaim, IndexedEmail,
    IndexedLink, IndexedNote, IndexedTag, IndexedTask, LinkKind, MovedNoteAddress, NoteKind,
    TagFacet,
};
use rusqlite::Connection;
use sea_query::{QueryStatementWriter, SqliteQueryBuilder};
use serde_json::Value;

use super::chat_write::{delete_conversation, save_message};
use super::connections::{migrate, migrate_to, open_in_memory, open_index_at, validate_migrations};
use super::embed_write::{apply_chunks, remove_chunks};
use super::query::run_query;
use super::read::assets::note_paths;
use super::read::backlinks::{
    backlinks, page as backlink_page, page_positions_query, page_sources_query,
};
use super::read::chat::{conversations, messages};
use super::read::daily::{dates_in_range, notes_in_range};
use super::read::embed::chunk_hashes;
use super::read::embed::{related_chunks, semantic_chunks};
use super::read::lists::{
    list_notes, list_notes_query, list_tags_query, note_tags, recent_notes, recent_notes_query,
};
use super::read::meta::meta;
use super::read::notes::privacy;
use super::read::notes::{
    embeddable_paths, file_facts, note as note_row, note_ids, path_taken, person_owners,
    pinned_notes, random_note, resolve_target, templates,
};
use super::read::search::{RankedOptions, ranked_query, ranked_query_plan, recall_query, search};
use super::read::stats::graph_stats;
use super::read::suggest::{
    key_winners, tags as suggest_tags, tags_query, title_candidates_query, wiki_candidates,
    winning_aliases,
};
use super::read::tasks::tasks;
use super::read::wiki::{
    address_note, claim_match, link_sources, notes_by_path_key, path_link_sources, resolve,
};
use super::scan::scan_reconcile;
use super::text::fts::build_fts_match;
use super::write::{apply_note, claim_tier, clear_index, move_note, touch_note};
use super::{Applied, FileIndexConnections, IndexConnections, IndexSession};
use reflect_types::{BacklinkSourceCursor, SearchRequest};

fn migrated() -> Connection {
    // Registers sqlite-vec before migrating — the 0002 migration creates a
    // vec0 table, so a raw rusqlite open would fail with "no such module".
    let mut conn = open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys=ON;").expect("fk");
    migrate(&mut conn).expect("migrate");
    conn
}

/// The filename-stem key the TS projection derives (`noteBasenameKey`).
fn stem_key(path: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    filename.trim_end_matches(".md").to_lowercase()
}

/// Mirrors `projectNoteClaims`'s seen-set: first claim of a key wins.
fn push_claim(claims: &mut Vec<IndexedClaim>, key: &str, tier: i64) {
    if !key.is_empty() && !claims.iter().any(|claim| claim.key == key) {
        claims.push(IndexedClaim {
            key: key.to_string(),
            tier,
        });
    }
}

fn note(path: &str, title: &str, links: Vec<IndexedLink>) -> IndexedNote {
    let mut claims = Vec::new();
    push_claim(&mut claims, &title.to_lowercase(), claim_tier::TITLE);
    push_claim(&mut claims, &stem_key(path), claim_tier::BASENAME);
    IndexedNote {
        path: path.to_string(),
        id: None,
        title: title.to_string(),
        title_key: title.to_lowercase(),
        path_key: path.to_lowercase(),
        kind: NoteKind::Note,
        daily_date: None,
        is_private: false,
        is_pinned: false,
        pinned_order: None,
        has_content: true,
        gist_url: None,
        gist_stale: false,
        file_hash: "h".to_string(),
        mtime: 0,
        text: format!("{title} body"),
        asset_text: String::new(),
        preview: "body".to_string(),
        links,
        tags: vec![],
        aliases: vec![],
        claims,
        emails: vec![],
        assets: vec![],
        tasks: vec![],
    }
}

fn wiki(target: &str) -> IndexedLink {
    IndexedLink {
        kind: LinkKind::Wiki,
        target_raw: target.to_string(),
        target_key: target.to_lowercase(),
        target_path_key: None,
        alias: None,
        pos_from: 0,
        pos_to: 0,
    }
}

/// A link that names an exact file (`[[Projects/Plan]]` or `[x](./plan.md)`).
fn path_link(kind: LinkKind, target_raw: &str, target_path_key: &str) -> IndexedLink {
    IndexedLink {
        kind,
        target_raw: target_raw.to_string(),
        target_key: target_raw.to_lowercase(),
        target_path_key: Some(target_path_key.to_string()),
        alias: None,
        pos_from: 0,
        pos_to: 0,
    }
}

fn aliased_note(path: &str, title: &str, alias: &str) -> IndexedNote {
    let mut indexed = note(path, title, vec![]);
    indexed.aliases = vec![IndexedAlias {
        alias: alias.to_string(),
        alias_key: alias.to_lowercase(),
    }];
    let mut claims = Vec::new();
    push_claim(&mut claims, &title.to_lowercase(), 2);
    push_claim(&mut claims, &alias.to_lowercase(), claim_tier::ALIAS);
    push_claim(&mut claims, &stem_key(path), 4);
    indexed.claims = claims;
    indexed
}

fn daily_note(path: &str, date: &str) -> IndexedNote {
    let mut indexed = note(path, date, vec![]);
    indexed.kind = NoteKind::Daily;
    indexed.daily_date = Some(date.to_string());
    let mut claims = Vec::new();
    push_claim(&mut claims, date, claim_tier::DAILY_DATE);
    push_claim(&mut claims, &date.to_lowercase(), claim_tier::TITLE);
    push_claim(&mut claims, &stem_key(path), claim_tier::BASENAME);
    indexed.claims = claims;
    indexed
}

/// What the TS `movedNoteAddress` computes for a test path (never a daily).
fn moved_address(to: &str) -> MovedNoteAddress {
    MovedNoteAddress {
        path_key: to.to_lowercase(),
        basename_key: stem_key(to),
        daily_date: None,
    }
}

fn task(index: i64, markdown: &str, checked: bool) -> IndexedTask {
    IndexedTask {
        ast_path: format!("[{index}]"),
        markdown: markdown.to_string(),
        breadcrumbs: vec![],
        checked,
        due_date: None,
    }
}

#[test]
fn migrations_are_valid_and_idempotent() {
    // Guards every migration's SQL (rusqlite_migration validates the set).
    validate_migrations().expect("migration set is valid");
    let mut conn = migrated();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, LATEST_SCHEMA_VERSION as i64);
    migrate(&mut conn).expect("re-running to_latest is a no-op");
}

#[test]
fn tag_search_indexes_are_created() {
    let conn = migrated();
    let has_tags_index: bool = conn
        .prepare("SELECT 1 FROM pragma_index_list('tags') WHERE name = ?1")
        .unwrap()
        .exists(["tags_tag_key_note_path"])
        .unwrap();
    assert!(has_tags_index);

    let has_notes_index: bool = conn
        .prepare("SELECT 1 FROM pragma_index_list('notes') WHERE name = ?1")
        .unwrap()
        .exists(["notes_daily_date_mtime_path"])
        .unwrap();
    assert!(has_notes_index);

    let tag_columns: Vec<(String, i64)> = conn
        .prepare(
            "SELECT name, seqno FROM pragma_index_xinfo('tags_tag_key_note_path')
             WHERE key = 1 ORDER BY seqno",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        tag_columns,
        vec![("tag_key".to_string(), 0), ("note_path".to_string(), 1)]
    );

    let notes_columns: Vec<(String, i64, i64)> = conn
        .prepare(
            "SELECT name, seqno, \"desc\" FROM pragma_index_xinfo('notes_daily_date_mtime_path')
             WHERE key = 1 ORDER BY seqno",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        notes_columns,
        vec![
            ("daily_date".to_string(), 0, 0),
            ("mtime".to_string(), 1, 1),
            ("path".to_string(), 2, 0),
        ]
    );
}

#[test]
fn preview_and_tag_keys_round_trip() {
    let conn = migrated();
    let mut tagged = note("notes/a.md", "A", vec![]);
    tagged.preview = "first body line".to_string();
    tagged.tags = vec![IndexedTag {
        tag: "Café".to_string(),
        tag_key: "café".to_string(),
    }];
    apply_note(&conn, &tagged).unwrap();

    let notes = run_query(&conn, "SELECT preview FROM notes", &[]).unwrap();
    assert_eq!(notes[0]["preview"], Value::from("first body line"));

    // Display casing and the TS-folded key are stored side by side — matching
    // happens on tag_key (SQLite's lower() couldn't fold the É).
    let tags = run_query(&conn, "SELECT tag, tag_key FROM tags", &[]).unwrap();
    assert_eq!(tags[0]["tag"], Value::from("Café"));
    assert_eq!(tags[0]["tag_key"], Value::from("café"));
}

#[test]
fn note_emails_apply_move_and_cascade() {
    let conn = migrated();
    let mut person = note("notes/jane-doe.md", "Jane Doe", vec![]);
    person.emails = vec![IndexedEmail {
        email: "Jane@Corp.com".to_string(),
        email_key: "jane@corp.com".to_string(),
    }];
    apply_note(&conn, &person).unwrap();

    // Display casing and the folded match key are stored side by side, like tags.
    let rows = run_query(
        &conn,
        "SELECT note_path, email, email_key FROM note_emails",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["email"], Value::from("Jane@Corp.com"));
    assert_eq!(rows[0]["email_key"], Value::from("jane@corp.com"));

    // A rename carries the rows to the new path (inside the same deferred-FK
    // transaction the command layer would open).
    conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
        .unwrap();
    move_note(
        &conn,
        "notes/jane-doe.md",
        "notes/jane.md",
        &moved_address("notes/jane.md"),
    )
    .unwrap();
    conn.execute_batch("COMMIT;").unwrap();
    let moved = run_query(&conn, "SELECT note_path FROM note_emails", &[]).unwrap();
    assert_eq!(moved[0]["note_path"], Value::from("notes/jane.md"));

    // Re-applying with no emails replaces the rows rather than accreting.
    let mut renamed = note("notes/jane.md", "Jane Doe", vec![]);
    renamed.emails = vec![];
    apply_note(&conn, &renamed).unwrap();
    let cleared = run_query(&conn, "SELECT note_path FROM note_emails", &[]).unwrap();
    assert!(cleared.is_empty());
}

#[test]
fn backlinks_resolve_by_title_at_query_time() {
    let conn = migrated();
    // Source links to "Target" before the target note even exists.
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Target")])).unwrap();
    let none = run_query(
        &conn,
        "SELECT source_path FROM backlinks WHERE target_path = ?1",
        &[Value::from("notes/target.md")],
    )
    .unwrap();
    assert!(none.is_empty());

    // Creating the target immediately resolves the inbound link (join, no reindex).
    apply_note(&conn, &note("notes/target.md", "Target", vec![])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT source_path FROM backlinks WHERE target_path = ?1",
        &[Value::from("notes/target.md")],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["source_path"], Value::from("notes/a.md"));
}

#[test]
fn backlinks_resolve_by_alias_when_the_key_has_no_stronger_claimant() {
    let conn = migrated();
    apply_note(
        &conn,
        &aliased_note("notes/tim-maccaw-dad.md", "Tim MacCaw // Dad", "Dad"),
    )
    .unwrap();
    apply_note(&conn, &note("notes/source.md", "Source", vec![wiki("Dad")])).unwrap();

    let rows = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/source.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["target_path"],
        Value::from("notes/tim-maccaw-dad.md")
    );
}

#[test]
fn backlink_resolution_uses_daily_then_title_then_alias_precedence() {
    let conn = migrated();
    apply_note(
        &conn,
        &aliased_note("notes/aliased-date.md", "Release Day", "2026-07-10"),
    )
    .unwrap();
    apply_note(&conn, &note("notes/titled-date.md", "2026-07-10", vec![])).unwrap();
    apply_note(&conn, &daily_note("daily/2026-07-10.md", "2026-07-10")).unwrap();
    apply_note(
        &conn,
        &note(
            "notes/date-source.md",
            "Date Source",
            vec![wiki("2026-07-10")],
        ),
    )
    .unwrap();

    apply_note(
        &conn,
        &aliased_note("notes/tim-maccaw-dad.md", "Tim MacCaw // Dad", "Dad"),
    )
    .unwrap();
    apply_note(&conn, &note("notes/dad.md", "Dad", vec![])).unwrap();
    apply_note(
        &conn,
        &note("notes/dad-source.md", "Dad Source", vec![wiki("Dad")]),
    )
    .unwrap();

    let rows = run_query(
        &conn,
        "SELECT source_path, target_path FROM backlinks ORDER BY source_path",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["source_path"], Value::from("notes/dad-source.md"));
    assert_eq!(rows[0]["target_path"], Value::from("notes/dad.md"));
    assert_eq!(rows[1]["source_path"], Value::from("notes/date-source.md"));
    assert_eq!(rows[1]["target_path"], Value::from("daily/2026-07-10.md"));
}

#[test]
fn note_addressing_migrations_preserve_rows_and_reproject_resolution() {
    let mut conn = open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    migrate_to(&mut conn, 17).expect("stage v17");

    // Rows as a v17 writer shaped them: no `path_key`, no `note_claims`.
    for (path, title) in [("notes/dad.md", "Dad"), ("notes/source.md", "Source")] {
        conn.execute(
            "INSERT INTO notes(path, title, title_key, kind, file_hash, mtime, updated_at)
             VALUES(?1, ?2, ?3, 'note', 'h', 0, 0)",
            rusqlite::params![path, title, title.to_lowercase()],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO links(source_path, kind, target_raw, target_key, pos_from, pos_to)
         VALUES('notes/source.md', 'wiki', 'Dad', 'dad', 0, 0)",
        [],
    )
    .unwrap();

    let counts_before: Vec<i64> = ["notes", "links"]
        .iter()
        .map(|table| {
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        })
        .collect();

    migrate(&mut conn).expect("migrate to latest");

    // Neither 0018 nor 0019 wipes projection rows...
    let counts_after: Vec<i64> = ["notes", "links"]
        .iter()
        .map(|table| {
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        })
        .collect();
    assert_eq!(counts_after, counts_before);

    // ...but name resolution now reads `note_claims`, which pre-0019 rows do
    // not have: links stay unresolved until the projection-version bump
    // rebuilds them on the next open.
    let stale = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/source.md'",
        &[],
    )
    .unwrap();
    assert!(stale.is_empty());

    // The reprojection restores resolution through the claims table.
    apply_note(&conn, &note("notes/dad.md", "Dad", vec![])).unwrap();
    apply_note(&conn, &note("notes/source.md", "Source", vec![wiki("Dad")])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/source.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target_path"], Value::from("notes/dad.md"));
}

#[test]
fn alias_collisions_choose_the_first_path_for_backlinks() {
    let conn = migrated();
    apply_note(&conn, &aliased_note("notes/zeta.md", "Zeta", "Shared Name")).unwrap();
    apply_note(
        &conn,
        &aliased_note("notes/alpha.md", "Alpha", "Shared Name"),
    )
    .unwrap();
    conn.execute(
        "INSERT INTO aliases(note_path, alias, alias_key) VALUES (?1, ?2, ?3)",
        ["notes/alpha.md", "SHARED NAME", "shared name"],
    )
    .unwrap();
    apply_note(
        &conn,
        &note("notes/source.md", "Source", vec![wiki("Shared Name")]),
    )
    .unwrap();

    let rows = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/source.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target_path"], Value::from("notes/alpha.md"));

    let keys = run_query(
        &conn,
        "SELECT note_path, claim_count FROM note_keys WHERE key = 'shared name'",
        &[],
    )
    .unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["note_path"], Value::from("notes/alpha.md"));
    assert_eq!(keys[0]["claim_count"], Value::from(2));

    conn.execute("DELETE FROM notes WHERE path = ?1", ["notes/alpha.md"])
        .unwrap();
    let fallback = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/source.md'",
        &[],
    )
    .unwrap();
    assert_eq!(fallback.len(), 1);
    assert_eq!(fallback[0]["target_path"], Value::from("notes/zeta.md"));
    let fallback_key = run_query(
        &conn,
        "SELECT note_path, claim_count FROM note_keys WHERE key = 'shared name'",
        &[],
    )
    .unwrap();
    assert_eq!(fallback_key[0]["note_path"], Value::from("notes/zeta.md"));
    assert_eq!(fallback_key[0]["claim_count"], Value::from(1));
}

#[test]
fn templates_are_invisible_to_backlink_resolution() {
    let conn = migrated();
    let mut template = note("templates/journal.md", "Journal", vec![wiki("Target")]);
    template.kind = NoteKind::Template;
    template.claims = vec![];
    apply_note(&conn, &template).unwrap();
    apply_note(&conn, &note("notes/target.md", "Target", vec![])).unwrap();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Journal")])).unwrap();

    // A note linking [[Journal]] must not resolve to the template's title…
    let to_template = run_query(
        &conn,
        "SELECT source_path FROM backlinks WHERE target_path = ?1",
        &[Value::from("templates/journal.md")],
    )
    .unwrap();
    assert!(to_template.is_empty());

    // …and the template's boilerplate [[Target]] link is not a graph edge.
    let from_template = run_query(
        &conn,
        "SELECT source_path FROM backlinks WHERE target_path = ?1",
        &[Value::from("notes/target.md")],
    )
    .unwrap();
    assert!(from_template.is_empty());
}

#[test]
fn asset_description_text_is_searchable_but_stays_out_of_the_preview() {
    let conn = migrated();
    // The note body says nothing about a waterfall; only the asset description
    // (folded into the FTS body, Plan 20) does.
    let mut sample = note("notes/a.md", "Trip", vec![]);
    sample.text = "Trip planning".to_string();
    sample.preview = "Trip planning".to_string();
    sample.asset_text = "A photo of a waterfall in a green canyon.".to_string();
    apply_note(&conn, &sample).unwrap();

    // A query that appears only in the asset description surfaces the note.
    let hits = run_query(
        &conn,
        "SELECT path FROM search_fts WHERE search_fts MATCH ?1",
        &[Value::from("waterfall")],
    )
    .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["path"], Value::from("notes/a.md"));

    // The note body is still searchable alongside it.
    let body_hits = run_query(
        &conn,
        "SELECT path FROM search_fts WHERE search_fts MATCH ?1",
        &[Value::from("planning")],
    )
    .unwrap();
    assert_eq!(body_hits.len(), 1);

    // The asset text never leaks into the preview.
    let preview: String = conn
        .query_row(
            "SELECT preview FROM notes WHERE path = 'notes/a.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !preview.contains("waterfall"),
        "preview must not carry asset text"
    );
}

#[test]
fn pinned_migration_drops_stale_note_rows_for_reindex() {
    // Rows indexed before 0003 would keep is_pinned=0 even where the file
    // already says `pinned: true` (the open-time reconcile hash-skips
    // unchanged files) — the migration wipes the projection so the next open
    // re-indexes everything with the new column populated.
    let mut conn = open_in_memory().expect("open");
    migrate_to(&mut conn, 2).expect("migrate to v2");
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash) VALUES('notes/a.md', 'A', 'a', 'h');
         INSERT INTO tags(note_path, tag) VALUES('notes/a.md', 'x');
         INSERT INTO search_fts(path, title, body) VALUES('notes/a.md', 'A', 'A body');
         INSERT INTO index_meta(key, value) VALUES('k', 'v');",
    )
    .expect("stage v2 rows");

    migrate(&mut conn).expect("migrate to latest");
    for table in ["notes", "tags", "search_fts"] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} should be wiped for the re-index");
    }
    // Bookkeeping outlives the wipe (same contract as index_clear).
    let meta: i64 = conn
        .query_row("SELECT count(*) FROM index_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(meta, 1);
}

#[test]
fn pinned_flag_and_order_round_trip_into_the_notes_row() {
    let conn = migrated();
    let mut pinned = note("notes/p.md", "P", vec![]);
    pinned.is_pinned = true;
    pinned.pinned_order = Some(1.5);
    apply_note(&conn, &pinned).unwrap();
    apply_note(&conn, &note("notes/q.md", "Q", vec![])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT path, pinned_order FROM notes WHERE is_pinned = 1",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["path"], Value::from("notes/p.md"));
    assert_eq!(rows[0]["pinned_order"], Value::from(1.5));
}

#[test]
fn gist_columns_round_trip_into_the_notes_row() {
    let conn = migrated();
    let mut published = note("notes/g.md", "G", vec![]);
    published.gist_url = Some("https://gist.github.com/alex/abc123".to_string());
    published.gist_stale = true;
    apply_note(&conn, &published).unwrap();
    apply_note(&conn, &note("notes/plain.md", "Plain", vec![])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT path, gist_url FROM notes WHERE gist_stale = 1",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["path"], Value::from("notes/g.md"));
    assert_eq!(
        rows[0]["gist_url"],
        Value::from("https://gist.github.com/alex/abc123")
    );

    // Re-indexing after a republish (matching hash again) clears the flag.
    published.gist_stale = false;
    apply_note(&conn, &published).unwrap();
    let rows = run_query(&conn, "SELECT path FROM notes WHERE gist_stale = 1", &[]).unwrap();
    assert!(rows.is_empty());
}

#[test]
fn reapplying_a_note_replaces_its_rows() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X"), wiki("Y")])).unwrap();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Z")])).unwrap();
    let rows = run_query(&conn, "SELECT target_key FROM links", &[]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target_key"], Value::from("z"));
}

#[test]
fn has_content_lands_on_the_notes_row_and_is_queryable() {
    let conn = migrated();
    let mut blank = note("daily/2026-06-02.md", "2026-06-02", vec![]);
    blank.kind = NoteKind::Daily;
    blank.daily_date = Some("2026-06-02".to_string());
    blank.has_content = false;
    apply_note(&conn, &blank).unwrap();
    let mut written = note("daily/2026-06-01.md", "2026-06-01", vec![]);
    written.kind = NoteKind::Daily;
    written.daily_date = Some("2026-06-01".to_string());
    apply_note(&conn, &written).unwrap();

    let dotted = run_query(
        &conn,
        "SELECT daily_date FROM notes WHERE daily_date IS NOT NULL AND has_content = 1
         ORDER BY daily_date",
        &[],
    )
    .unwrap();
    assert_eq!(dotted.len(), 1);
    assert_eq!(dotted[0]["daily_date"], Value::from("2026-06-01"));
}

#[test]
fn reconcile_scan_classifies_candidates_orphans_and_skips() {
    let conn = migrated();
    let now: u64 = 100_000;
    let indexed = |path: &str, mtime: i64, hash: &str| {
        let mut row = note(path, "T", vec![]);
        row.mtime = mtime;
        row.file_hash = hash.to_string();
        apply_note(&conn, &row).unwrap();
    };
    indexed("notes/settled.md", 1_000, "settled-hash");
    indexed("notes/moved.md", 1_000, "moved-hash");
    indexed("notes/fresh.md", (now - 1_000) as i64, "fresh-hash");
    indexed("notes/evicted.md", 1_000, "evicted-hash");
    indexed("notes/evicted-current.md", 9_000, "current-hash");
    indexed("notes/gone.md", 1_000, "gone-hash");

    let meta = |path: &str, modified_ms: u64, placeholder: bool| reflect_types::FileMeta {
        path: path.to_string(),
        size: 1,
        modified_ms,
        placeholder,
    };
    let files = [
        meta("notes/settled.md", 1_000, false), // row matches, settled → skipped
        meta("notes/moved.md", 2_000, false),   // mtime moved → candidate with facts
        meta("notes/fresh.md", now - 1_000, false), // matches but too fresh to trust → candidate
        meta("notes/new.md", 3_000, false),     // no row → arrival candidate
        meta("notes/evicted.md", 9_000, true),  // placeholder, stale row → download request
        meta("notes/evicted-current.md", 9_000, true), // placeholder, row current → left evicted
        meta("notes/evicted-new.md", 4_000, true), // placeholder, no row → download request
    ];

    let scan = scan_reconcile(&conn, &files, now).unwrap();

    assert_eq!(scan.total, 7);
    let paths: Vec<&str> = scan
        .candidates
        .iter()
        .map(|candidate| candidate.path.as_str())
        .collect();
    assert_eq!(paths, ["notes/moved.md", "notes/fresh.md", "notes/new.md"]);
    let moved = &scan.candidates[0];
    assert_eq!(moved.modified_ms, 2_000);
    assert_eq!(moved.stored_mtime, Some(1_000));
    assert_eq!(moved.stored_hash.as_deref(), Some("moved-hash"));
    let arrival = &scan.candidates[2];
    assert_eq!(arrival.stored_mtime, None);
    assert_eq!(arrival.stored_hash, None);

    // Only the vanished row is an orphan — eviction must not read as deletion.
    let orphan_paths: Vec<&str> = scan
        .orphans
        .iter()
        .map(|orphan| orphan.path.as_str())
        .collect();
    assert_eq!(orphan_paths, ["notes/gone.md"]);
    assert_eq!(scan.orphans[0].stored_hash, "gone-hash");
    assert_eq!(scan.orphans[0].stored_mtime, 1_000);

    // Placeholders whose content the index lacks (stale or missing rows) are
    // reported for a targeted download; a current row stays evicted in peace.
    assert_eq!(
        scan.stale_placeholders,
        ["notes/evicted.md", "notes/evicted-new.md"]
    );
}

#[test]
fn touch_note_restamps_mtime_and_updated_at_without_creating_rows() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();

    touch_note(&conn, "notes/a.md", 4_200).unwrap();
    let rows = run_query(
        &conn,
        "SELECT mtime, updated_at FROM notes WHERE path = ?1",
        &[Value::from("notes/a.md")],
    )
    .unwrap();
    assert_eq!(rows[0]["mtime"], Value::from(4_200));
    assert_eq!(rows[0]["updated_at"], Value::from(4_200));

    // A path with no row updates nothing — a touch must never resurrect a
    // removed note.
    touch_note(&conn, "notes/gone.md", 4_200).unwrap();
    let count = run_query(&conn, "SELECT COUNT(*) AS n FROM notes", &[]).unwrap();
    assert_eq!(count[0]["n"], Value::from(1));
}

#[test]
fn fts_matches_indexed_body() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "Quick", vec![])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT path FROM search_fts WHERE search_fts MATCH ?1",
        &[Value::from("quick")],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
}

#[test]
fn run_query_rejects_mutating_statements() {
    let conn = migrated();
    assert!(run_query(&conn, "DELETE FROM notes", &[]).is_err());
    assert!(run_query(&conn, "SELECT count(*) FROM notes", &[]).is_ok());
}

#[test]
fn clear_cascades_to_child_tables() {
    let conn = migrated();
    let mut seeded = note("notes/a.md", "A", vec![wiki("X")]);
    seeded.tasks = vec![task(0, "buy milk", false)];
    apply_note(&conn, &seeded).unwrap();
    clear_index(&conn).unwrap();
    // Deleting notes cascades to children; search_fts is cleared explicitly.
    for table in [
        "notes",
        "links",
        "tags",
        "aliases",
        "assets",
        "tasks",
        "search_fts",
    ] {
        let rows = run_query(&conn, &format!("SELECT count(*) AS n FROM {table}"), &[]).unwrap();
        assert_eq!(rows[0]["n"], Value::from(0), "{table} should be empty");
    }
}

#[test]
fn reapplying_a_note_cascades_away_stale_children() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X"), wiki("Y")])).unwrap();
    // Re-applying clears the note (cascade) before reinserting, so the old
    // tags/links don't linger even though apply_note lists no explicit deletes.
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    let rows = run_query(&conn, "SELECT count(*) AS n FROM links", &[]).unwrap();
    assert_eq!(rows[0]["n"], Value::from(0));
}

#[test]
fn apply_note_inserts_tasks_and_replace_clears_them() {
    let conn = migrated();
    let mut seeded = note("notes/a.md", "A", vec![]);
    let mut due = task(4, "buy milk", false);
    due.due_date = Some("2026-07-01".to_string());
    seeded.tasks = vec![due, task(20, "call mum", true)];
    apply_note(&conn, &seeded).unwrap();

    let rows = run_query(
        &conn,
        "SELECT ast_path, markdown, breadcrumbs, checked, due_date FROM tasks WHERE note_path = 'notes/a.md' ORDER BY rowid",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["ast_path"], Value::from("[4]"));
    assert_eq!(rows[0]["markdown"], Value::from("buy milk"));
    assert_eq!(rows[0]["breadcrumbs"], Value::from("[]"));
    assert_eq!(rows[0]["checked"], Value::from(0));
    assert_eq!(rows[0]["due_date"], Value::from("2026-07-01"));
    assert_eq!(rows[1]["checked"], Value::from(1));
    assert_eq!(rows[1]["due_date"], Value::Null);

    // Re-applying with no tasks cascades the old rows away (no explicit delete).
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    let after = run_query(&conn, "SELECT count(*) AS n FROM tasks", &[]).unwrap();
    assert_eq!(after[0]["n"], Value::from(0));
}

#[test]
fn apply_note_serializes_task_breadcrumbs() {
    let conn = migrated();
    let mut seeded = note("notes/a.md", "A", vec![]);
    let mut with_context = task(4, "ship it", false);
    with_context.breadcrumbs = vec!["Project".to_string(), "Phase one".to_string()];
    seeded.tasks = vec![with_context];
    apply_note(&conn, &seeded).unwrap();

    let rows = run_query(
        &conn,
        "SELECT breadcrumbs FROM tasks WHERE note_path = 'notes/a.md'",
        &[],
    )
    .unwrap();
    assert_eq!(
        rows[0]["breadcrumbs"],
        Value::from("[\"Project\",\"Phase one\"]")
    );
}

#[test]
fn open_tasks_read_includes_private_notes_and_excludes_completed() {
    // The semantics `getOpenTasks` (queries.ts) relies on: open checkboxes joined
    // to note context, completed tasks excluded, and `private: true` notes' tasks
    // INCLUDED (the Tasks view is a local-only surface, like local search).
    let conn = migrated();
    let mut public = note("daily/2026-06-10.md", "A", vec![]);
    public.kind = NoteKind::Daily;
    public.daily_date = Some("2026-06-10".to_string());
    public.tasks = vec![task(2, "open a", false)];
    apply_note(&conn, &public).unwrap();

    let mut private = note("notes/b.md", "B", vec![]);
    private.is_private = true;
    private.tasks = vec![task(2, "open b", false), task(20, "done b", true)];
    apply_note(&conn, &private).unwrap();

    let rows = run_query(
        &conn,
        "SELECT tasks.note_path, tasks.markdown AS text, notes.title AS note_title, notes.daily_date \
         FROM tasks INNER JOIN notes ON notes.path = tasks.note_path \
         WHERE tasks.checked = 0 ORDER BY tasks.note_path, tasks.rowid",
        &[],
    )
    .unwrap();

    assert_eq!(rows.len(), 2); // both open tasks; the completed one is gone
    assert_eq!(rows[0]["note_path"], Value::from("daily/2026-06-10.md"));
    assert_eq!(rows[0]["text"], Value::from("open a"));
    assert_eq!(rows[0]["note_title"], Value::from("A"));
    assert_eq!(rows[0]["daily_date"], Value::from("2026-06-10"));
    // The private note's open task is present (local-only surface).
    assert_eq!(rows[1]["note_path"], Value::from("notes/b.md"));
    assert_eq!(rows[1]["text"], Value::from("open b"));
}

#[test]
fn link_kind_check_rejects_unknown_kinds() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    let bogus = conn.execute(
        "INSERT INTO links(source_path, kind, target_raw, target_key, pos_from, pos_to)
         VALUES('notes/a.md', 'bogus', 'X', 'x', 0, 0)",
        [],
    );
    assert!(
        bogus.is_err(),
        "CHECK should reject kinds other than wiki/md"
    );
}

#[test]
fn note_kind_daily_date_invariant_is_enforced() {
    // `kind` and `daily_date` both derive from the path in `buildIndexedNote`,
    // so they agree by construction — the 0015 CHECK makes SQLite reject any
    // writer that drifts: kind = 'daily' iff daily_date is set.
    let conn = migrated();

    let note_with_date = conn.execute(
        "INSERT INTO notes(path, title, title_key, kind, daily_date, file_hash)
         VALUES('notes/a.md', 'A', 'a', 'note', '2026-07-01', 'h')",
        [],
    );
    assert!(
        note_with_date.is_err(),
        "CHECK should reject kind='note' with a daily_date"
    );

    let daily_without_date = conn.execute(
        "INSERT INTO notes(path, title, title_key, kind, daily_date, file_hash)
         VALUES('daily/2026-07-01.md', 'July 1st, 2026', 'july 1st, 2026', 'daily', NULL, 'h')",
        [],
    );
    assert!(
        daily_without_date.is_err(),
        "CHECK should reject kind='daily' without a daily_date"
    );

    let template_with_date = conn.execute(
        "INSERT INTO notes(path, title, title_key, kind, daily_date, file_hash)
         VALUES('templates/j.md', 'J', 'j', 'template', '2026-07-01', 'h')",
        [],
    );
    assert!(
        template_with_date.is_err(),
        "CHECK should reject kind='template' with a daily_date"
    );

    // The three shapes buildIndexedNote actually emits all pass.
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, kind, daily_date, file_hash) VALUES
           ('daily/2026-07-01.md', 'July 1st, 2026', 'july 1st, 2026', 'daily', '2026-07-01', 'h'),
           ('notes/a.md', 'A', 'a', 'note', NULL, 'h'),
           ('templates/j.md', 'J', 'j', 'template', NULL, 'h');",
    )
    .expect("consistent rows insert");
}

#[test]
fn kind_invariant_migration_wipes_the_projection_for_reindex() {
    // 0015 drops and recreates `notes` (a table-level CHECK cannot be ADDed)
    // while six child tables reference it ON DELETE CASCADE. The projection
    // is wiped children-first (so the DROP's implicit DELETE cascades over
    // empty tables even with enforcement on) and the next open re-indexes.
    let mut conn = open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys=ON;").expect("fk");
    migrate_to(&mut conn, 14).expect("migrate to v14");
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, kind, daily_date, file_hash) VALUES
           ('daily/2026-07-01.md', 'July 1st, 2026', 'july 1st, 2026', 'daily', '2026-07-01', 'h1'),
           ('notes/a.md', 'A', 'a', 'note', NULL, 'h2');
         INSERT INTO note_text(note_path, text) VALUES('notes/a.md', 'A body');
         INSERT INTO links(source_path, kind, target_raw, target_key, pos_from, pos_to)
           VALUES('notes/a.md', 'wiki', 'July 1st, 2026', 'july 1st, 2026', 0, 0);
         INSERT INTO tags(note_path, tag, tag_key) VALUES('notes/a.md', 'X', 'x');
         INSERT INTO tasks(note_path, marker_offset, text, raw, checked)
           VALUES('notes/a.md', 0, 'buy milk', '[ ] buy milk', 0);
         INSERT INTO search_fts(path, title, body) VALUES('notes/a.md', 'A', 'A body');
         INSERT INTO index_meta(key, value) VALUES('k', 'v');",
    )
    .expect("stage v14 rows");

    migrate(&mut conn).expect("migrate to latest");

    for table in ["notes", "links", "tags", "tasks", "search_fts"] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} should be wiped for the re-index");
    }
    // Bookkeeping outlives the wipe (same contract as index_clear).
    let meta: i64 = conn
        .query_row("SELECT count(*) FROM index_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(meta, 1);

    // Every notes index came back with the recreated table.
    for index in [
        "notes_title_key",
        "notes_daily_date",
        "notes_id",
        "notes_daily_date_mtime_path",
        "notes_non_daily_mtime",
        "notes_pinned",
        "notes_has_conflict",
    ] {
        let exists: bool = conn
            .prepare("SELECT 1 FROM pragma_index_list('notes') WHERE name = ?1")
            .unwrap()
            .exists([index])
            .unwrap();
        assert!(exists, "index {index} must be recreated with the table");
    }

    // The write path, the views, and the child cascades all bind to `notes`
    // by name — prove they resolve against the recreated table.
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Target")])).unwrap();
    apply_note(&conn, &note("notes/target.md", "Target", vec![])).unwrap();
    let backlink_sources: i64 = conn
        .query_row(
            "SELECT count(*) FROM backlinks WHERE target_path = 'notes/target.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(backlink_sources, 1);
    conn.execute("DELETE FROM notes WHERE path = 'notes/a.md'", [])
        .unwrap();
    let orphans: i64 = conn
        .query_row("SELECT count(*) FROM links", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        orphans, 0,
        "ON DELETE CASCADE must target the recreated table"
    );
}

#[test]
fn open_index_at_creates_migrates_and_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();

    let conn = open_index_at(root).expect("first open");
    assert!(root.join(".reflect/index.sqlite").exists());
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, LATEST_SCHEMA_VERSION as i64);
    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal");
    drop(conn);

    // Reopening an existing index is a no-op migration and preserves data.
    let conn = open_index_at(root).expect("first open");
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    drop(conn);
    let conn = open_index_at(root).expect("reopen");
    let rows = run_query(&conn, "SELECT count(*) AS n FROM notes", &[]).unwrap();
    assert_eq!(rows[0]["n"], Value::from(1));
}

#[test]
fn fts5_is_compiled_in() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts USING fts5(body);
         INSERT INTO fts(body) VALUES ('the quick brown fox');",
    )
    .expect("fts5 create/insert");
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM fts WHERE fts MATCH 'quick'",
            [],
            |row| row.get(0),
        )
        .expect("fts5 match");
    assert_eq!(hits, 1);
}

#[test]
fn sqlite_vec_loads_and_runs_knn() {
    let conn = open_in_memory().expect("open with vec");
    let version: String = conn
        .query_row("SELECT vec_version()", [], |row| row.get(0))
        .expect("vec_version");
    assert!(!version.is_empty());

    conn.execute_batch(
        "CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4]);
         INSERT INTO vec_items(rowid, embedding) VALUES
           (1, '[1, 2, 3, 4]'),
           (2, '[9, 9, 9, 9]');",
    )
    .expect("vec0 create/insert");

    let nearest: i64 = conn
        .query_row(
            "SELECT rowid FROM vec_items \
             WHERE embedding MATCH '[1, 2, 3, 4]' ORDER BY distance LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("vec0 knn");
    assert_eq!(nearest, 1);
}

// ---- embeddings (Plan 09) ---------------------------------------------------

fn chunk(hash: &str, vector: Option<Vec<f32>>) -> EmbeddedChunk {
    EmbeddedChunk {
        heading: None,
        pos_from: 0,
        pos_to: 10,
        text: format!("text {hash}"),
        content_hash: hash.to_string(),
        model_id: "all-MiniLM-L6-v2".to_string(),
        vector,
    }
}

fn vec384(fill: f32) -> Vec<f32> {
    vec![fill; 384]
}

/// Chunks only exist for indexed notes (apply_chunks guards on the row).
fn index_note(conn: &Connection, path: &str) {
    apply_note(conn, &note(path, "T", vec![])).unwrap();
}

fn chunk_rows(conn: &Connection) -> Vec<(String, String)> {
    conn.prepare("SELECT note_path, content_hash FROM embedding_chunks ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn vector_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM embedding_vectors", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn apply_chunks_inserts_new_and_drops_stale_with_their_vectors() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(
        &conn,
        "notes/a.md",
        &[
            chunk("h1", Some(vec384(0.1))),
            chunk("h2", Some(vec384(0.2))),
        ],
    )
    .unwrap();
    assert_eq!(vector_count(&conn), 2);

    // h2 survives unembedded (hash-skip); h3 is new; h1 is gone.
    apply_chunks(
        &conn,
        "notes/a.md",
        &[chunk("h2", None), chunk("h3", Some(vec384(0.3)))],
    )
    .unwrap();
    assert_eq!(
        chunk_rows(&conn),
        vec![
            ("notes/a.md".to_string(), "h2".to_string()),
            ("notes/a.md".to_string(), "h3".to_string()),
        ]
    );
    assert_eq!(vector_count(&conn), 2);
}

#[test]
fn unchanged_chunks_keep_vectors_but_refresh_positions() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("h1", Some(vec384(0.5)))]).unwrap();
    let mut moved = chunk("h1", None);
    moved.pos_from = 100;
    moved.pos_to = 140;
    apply_chunks(&conn, "notes/a.md", &[moved]).unwrap();
    let (from, to): (i64, i64) = conn
        .query_row(
            "SELECT pos_from, pos_to FROM embedding_chunks WHERE content_hash = 'h1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((from, to), (100, 140));
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn an_unchanged_chunk_without_a_stored_row_is_a_loud_error() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    let result = apply_chunks(&conn, "notes/a.md", &[chunk("missing", None)]);
    assert!(result.is_err());
}

#[test]
fn remove_chunks_drops_rows_and_vectors_for_one_note_only() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    index_note(&conn, "notes/b.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();
    apply_chunks(&conn, "notes/b.md", &[chunk("b1", Some(vec384(0.2)))]).unwrap();
    remove_chunks(&conn, "notes/a.md").unwrap();
    assert_eq!(
        chunk_rows(&conn),
        vec![("notes/b.md".to_string(), "b1".to_string())]
    );
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn clear_index_wipes_embeddings_too() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();
    clear_index(&conn).unwrap();
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}

#[test]
fn knn_query_returns_nearest_chunk_first() {
    let conn = migrated();
    index_note(&conn, "notes/near.md");
    index_note(&conn, "notes/far.md");
    let mut near = vec384(0.0);
    near[0] = 1.0;
    let mut far = vec384(0.0);
    far[1] = 1.0;
    apply_chunks(&conn, "notes/near.md", &[chunk("n", Some(near))]).unwrap();
    apply_chunks(&conn, "notes/far.md", &[chunk("f", Some(far))]).unwrap();

    let mut probe = vec![0.0f32; 384];
    probe[0] = 0.9;
    let probe_json = format!(
        "[{}]",
        probe
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    // The shape of the search query.
    let rows = run_query(
        &conn,
        "SELECT c.note_path FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 2
         ORDER BY v.distance",
        &[Value::String(probe_json)],
    )
    .unwrap();
    let first = rows[0].get("note_path").unwrap().as_str().unwrap();
    assert_eq!(first, "notes/near.md");
}

#[test]
fn reindexing_a_note_keeps_its_chunks_but_true_deletion_drops_them() {
    let mut conn = migrated();
    apply_note(&conn, &note("notes/a.md", "Alpha", vec![])).unwrap();
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();

    // Upsert path: apply_note re-creates the note row — chunks must survive
    // (the hash-skip depends on it).
    apply_note(&conn, &note("notes/a.md", "Alpha edited", vec![])).unwrap();
    assert_eq!(chunk_rows(&conn).len(), 1);
    assert_eq!(vector_count(&conn), 1);

    // Genuine deletion (the index_remove command shape): everything goes.
    let tx = conn.transaction().unwrap();
    super::write::remove_note(&tx, "notes/a.md").unwrap();
    super::embed_write::remove_chunks(&tx, "notes/a.md").unwrap();
    tx.commit().unwrap();
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}

#[test]
fn embedding_vectors_use_cosine_distance() {
    // A probe pointing the same direction as a stored vector but at half its
    // magnitude: cosine distance 0, L2 distance 0.5 — this test discriminates
    // the metric (retrieve.ts thresholds raw distances as cosine).
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    let mut stored = vec384(0.0);
    stored[0] = 1.0;
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(stored))]).unwrap();

    let mut probe = vec![0.0f32; 384];
    probe[0] = 0.5;
    let probe_json = format!(
        "[{}]",
        probe
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let rows = run_query(
        &conn,
        "SELECT v.distance FROM embedding_vectors v
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(probe_json)],
    )
    .unwrap();
    let distance = rows[0].get("distance").unwrap().as_f64().unwrap();
    assert!(
        distance.abs() < 1e-6,
        "expected cosine distance 0, got {distance}"
    );
}

#[test]
fn cosine_migration_preserves_stored_vectors() {
    // Stage a vector on the pre-cosine schema (0002), then run 0003: the
    // vector must survive the table rebuild byte-for-byte (no re-embedding),
    // matching itself at cosine distance 0.
    let mut conn = open_in_memory().expect("open");
    migrate_to(&mut conn, 2).expect("migrate to 0002");
    // Stage a note with raw SQL — apply_note writes is_pinned/pinned_order
    // which don't exist until 0004, so we insert the v2-era columns directly.
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash, mtime, updated_at) \
         VALUES('notes/a.md', 'A', 'a', 'h', 0, 0);",
    )
    .expect("stage v2 note");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.25)))]).unwrap();
    assert_eq!(vector_count(&conn), 1);

    migrate(&mut conn).expect("migrate to latest");
    assert_eq!(vector_count(&conn), 1);

    let vec_json = run_query(
        &conn,
        "SELECT vec_to_json(v.embedding) AS vec FROM embedding_vectors v",
        &[],
    )
    .unwrap()[0]
        .get("vec")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let rows = run_query(
        &conn,
        "SELECT c.note_path, v.distance FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(vec_json)],
    )
    .unwrap();
    assert_eq!(
        rows[0].get("note_path").unwrap().as_str().unwrap(),
        "notes/a.md"
    );
    let distance = rows[0].get("distance").unwrap().as_f64().unwrap();
    assert!(
        distance.abs() < 1e-6,
        "expected cosine distance 0, got {distance}"
    );
}

#[test]
fn stored_vectors_round_trip_through_vec_to_json() {
    // `related_chunks` seeds KNN with `vec_to_json(embedding)`;
    // pin the function name + shape against the real extension.
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.25)))]).unwrap();
    let rows = run_query(
        &conn,
        "SELECT vec_to_json(v.embedding) AS vec
         FROM embedding_chunks c JOIN embedding_vectors v ON v.rowid = c.id
         WHERE c.note_path = ?1 ORDER BY c.pos_from LIMIT 1",
        &[Value::String("notes/a.md".to_string())],
    )
    .unwrap();
    let vec = rows[0].get("vec").unwrap().as_str().unwrap();
    assert!(vec.starts_with('['));
    // And the JSON form is MATCH-able right back (the second relatedNotes query).
    let knn = run_query(
        &conn,
        "SELECT c.note_path FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(vec.to_string())],
    )
    .unwrap();
    assert_eq!(
        knn[0].get("note_path").unwrap().as_str().unwrap(),
        "notes/a.md"
    );
}

#[test]
fn apply_chunks_for_an_unindexed_path_is_a_cleaning_no_op() {
    // The embed pipeline can race index_remove: a late embed_apply for a
    // deleted note must not reinsert vectors for a dead path.
    let conn = migrated();
    let result = apply_chunks(&conn, "notes/gone.md", &[chunk("g1", Some(vec384(0.1)))]);
    assert!(result.is_ok());
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}

// ---- note_move (Plan 17) ----------------------------------------------------

fn move_in_txn(conn: &mut Connection, from: &str, to: &str) -> reflect_types::AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    move_note(&tx, from, to, &moved_address(to))?;
    tx.commit()?;
    Ok(())
}

#[test]
fn move_note_migrates_every_row_and_preserves_derived_state() {
    let mut conn = migrated();
    let mut moved = note("notes/old.md", "Kept Title", vec![wiki("Elsewhere")]);
    moved.is_pinned = true;
    moved.pinned_order = Some(2.5);
    moved.tasks = vec![task(0, "do thing", false)];
    apply_note(&conn, &moved).unwrap();
    apply_note(
        &conn,
        &note("notes/src.md", "Src", vec![wiki("Kept Title")]),
    )
    .unwrap();
    apply_chunks(&conn, "notes/old.md", &[chunk("m1", Some(vec384(0.5)))]).unwrap();
    let vectors_before = vector_count(&conn);

    move_in_txn(&mut conn, "notes/old.md", "notes/kept-title.md").unwrap();

    // The notes row moved — same derived state, nothing re-created.
    let row = run_query(
        &conn,
        "SELECT path, is_pinned, pinned_order FROM notes WHERE path = ?1",
        &[Value::String("notes/kept-title.md".to_string())],
    )
    .unwrap();
    assert_eq!(row.len(), 1);
    assert_eq!(row[0].get("is_pinned").unwrap().as_i64().unwrap(), 1);
    let gone = run_query(
        &conn,
        "SELECT path FROM notes WHERE path = ?1",
        &[Value::String("notes/old.md".to_string())],
    )
    .unwrap();
    assert!(gone.is_empty());

    // Children followed: outgoing links, FTS, embedding chunks (vectors kept).
    for (sql, expected) in [
        (
            "SELECT count(*) AS n FROM links WHERE source_path = 'notes/kept-title.md'",
            1,
        ),
        (
            "SELECT count(*) AS n FROM search_fts WHERE path = 'notes/kept-title.md'",
            1,
        ),
        (
            "SELECT count(*) AS n FROM embedding_chunks WHERE note_path = 'notes/kept-title.md'",
            1,
        ),
        (
            "SELECT count(*) AS n FROM embedding_chunks WHERE note_path = 'notes/old.md'",
            0,
        ),
        (
            "SELECT count(*) AS n FROM tasks WHERE note_path = 'notes/kept-title.md'",
            1,
        ),
        (
            "SELECT count(*) AS n FROM tasks WHERE note_path = 'notes/old.md'",
            0,
        ),
    ] {
        let rows = run_query(&conn, sql, &[]).unwrap();
        assert_eq!(
            rows[0].get("n").unwrap().as_i64().unwrap(),
            expected,
            "{sql}"
        );
    }
    assert_eq!(vector_count(&conn), vectors_before);

    // Inbound links resolve by title key, so the backlink follows the move.
    let backlinks = run_query(
        &conn,
        "SELECT source_path FROM backlinks WHERE target_path = 'notes/kept-title.md'",
        &[],
    )
    .unwrap();
    assert_eq!(
        backlinks[0].get("source_path").unwrap().as_str().unwrap(),
        "notes/src.md"
    );
}

#[test]
fn move_note_refuses_an_occupied_destination() {
    let mut conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    apply_note(&conn, &note("notes/b.md", "B", vec![])).unwrap();

    let result = move_in_txn(&mut conn, "notes/a.md", "notes/b.md");
    assert!(result.is_err());

    // Nothing changed: both rows intact (the transaction rolled back).
    for path in ["notes/a.md", "notes/b.md"] {
        let rows = run_query(
            &conn,
            "SELECT title FROM notes WHERE path = ?1",
            &[Value::String(path.to_string())],
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "{path}");
    }
}

#[test]
fn move_note_without_a_source_row_is_a_no_op_success() {
    // An unindexed file can still be renamed; the watcher indexes it at `to`.
    let mut conn = migrated();
    move_in_txn(&mut conn, "notes/ghost.md", "notes/ghost-2.md").unwrap();
    let rows = run_query(&conn, "SELECT count(*) AS n FROM notes", &[]).unwrap();
    assert_eq!(rows[0].get("n").unwrap().as_i64().unwrap(), 0);
}

#[test]
fn watcher_echo_after_a_move_is_benign_and_vectors_survive() {
    // The fs rename echoes back as remove(old) + upsert(new). Because the DB
    // moved first, the remove finds no rows and the upsert re-applies an
    // identical projection — and embedding chunks (which live outside
    // apply_note) keep their vectors. A rename must never trigger a re-embed.
    let mut conn = migrated();
    let mut moved = note("notes/old.md", "Kept Title", vec![]);
    moved.is_pinned = true;
    apply_note(&conn, &moved).unwrap();
    apply_chunks(&conn, "notes/old.md", &[chunk("e1", Some(vec384(0.25)))]).unwrap();
    move_in_txn(&mut conn, "notes/old.md", "notes/kept-title.md").unwrap();

    // Echo: remove(old) — no rows — then upsert(new) — identical projection.
    use super::write::remove_note;
    remove_note(&conn, "notes/old.md").unwrap();
    let mut echoed = note("notes/kept-title.md", "Kept Title", vec![]);
    echoed.is_pinned = true;
    apply_note(&conn, &echoed).unwrap();

    let rows = run_query(
        &conn,
        "SELECT is_pinned FROM notes WHERE path = 'notes/kept-title.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows[0].get("is_pinned").unwrap().as_i64().unwrap(), 1);
    assert_eq!(
        chunk_rows(&conn),
        vec![("notes/kept-title.md".to_string(), "e1".to_string())]
    );
    assert_eq!(vector_count(&conn), 1);
}

// ---- chat history (0008) ----------------------------------------------------

fn conversation(id: &str) -> ChatConversation {
    ChatConversation {
        id: id.to_string(),
        title: "What did I write about Rust?".to_string(),
        created_ms: 1_000,
        updated_ms: 1_000,
    }
}

fn chat_message(id: &str, conversation_id: &str) -> ChatMessageRow {
    ChatMessageRow {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        user_text: "What did I write about Rust?".to_string(),
        attachments: "[]".to_string(),
        parts: "[]".to_string(),
        response_messages: "[]".to_string(),
        created_ms: 1_000,
    }
}

#[test]
fn chat_message_save_round_trips_and_upserts_the_conversation() {
    let conn = migrated();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();

    let rows = run_query(
        &conn,
        "SELECT title, created_ms, updated_ms FROM chat_conversations WHERE id = 'c1'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["title"],
        Value::from("What did I write about Rust?")
    );

    // A later save bumps updated_ms but never rewrites title/created_ms —
    // the title is the conversation's identity, set once at creation.
    let mut later = conversation("c1");
    later.title = "ignored".to_string();
    later.created_ms = 9_000;
    later.updated_ms = 9_000;
    save_message(&conn, &later, &chat_message("m2", "c1")).unwrap();
    let rows = run_query(
        &conn,
        "SELECT title, created_ms, updated_ms FROM chat_conversations WHERE id = 'c1'",
        &[],
    )
    .unwrap();
    assert_eq!(
        rows[0]["title"],
        Value::from("What did I write about Rust?")
    );
    assert_eq!(rows[0]["created_ms"], Value::from(1_000));
    assert_eq!(rows[0]["updated_ms"], Value::from(9_000));
}

#[test]
fn chat_message_resave_updates_by_id() {
    // The settle-time save re-sends the same row id with the streamed result.
    let conn = migrated();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    let mut settled = chat_message("m1", "c1");
    settled.parts = r#"[{"kind":"text","text":"You wrote three notes."}]"#.to_string();
    settled.response_messages =
        r#"[{"role":"assistant","content":"You wrote three notes."}]"#.to_string();
    save_message(&conn, &conversation("c1"), &settled).unwrap();

    let rows = run_query(
        &conn,
        "SELECT parts FROM chat_messages WHERE id = 'm1'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["parts"],
        Value::from(r#"[{"kind":"text","text":"You wrote three notes."}]"#)
    );
}

#[test]
fn chat_message_seq_is_assigned_per_conversation() {
    // seq is computed inside the insert (MAX + 1 per conversation), never by
    // the caller — the frontend's view can undercount the table (the read
    // path drops rows it cannot parse), so a TS-derived counter could collide
    // with a row it never saw. Counters are independent per conversation, a
    // re-save keeps its slot, and the unique index stays on as a backstop.
    let conn = migrated();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m2", "c1")).unwrap();
    save_message(&conn, &conversation("c2"), &chat_message("m3", "c2")).unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m2", "c1")).unwrap();

    let rows = run_query(
        &conn,
        "SELECT id, seq FROM chat_messages ORDER BY conversation_id, seq",
        &[],
    )
    .unwrap();
    let slots: Vec<(String, i64)> = rows
        .iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap().to_string(),
                row["seq"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        slots,
        vec![
            ("m1".to_string(), 0),
            ("m2".to_string(), 1),
            ("m3".to_string(), 0),
        ]
    );
}

#[test]
fn chat_conversation_delete_cascades_to_messages() {
    let conn = migrated();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    save_message(&conn, &conversation("c2"), &chat_message("m2", "c2")).unwrap();
    delete_conversation(&conn, "c1").unwrap();

    let conversations = run_query(&conn, "SELECT id FROM chat_conversations", &[]).unwrap();
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0]["id"], Value::from("c2"));
    let messages = run_query(&conn, "SELECT id FROM chat_messages", &[]).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], Value::from("m2"));
}

#[test]
fn clear_index_preserves_chat_history() {
    // Chat rows are durable, not a rebuildable projection — the full-rebuild
    // wipe must leave them alone.
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    clear_index(&conn).unwrap();

    let notes = run_query(&conn, "SELECT count(*) AS n FROM notes", &[]).unwrap();
    assert_eq!(notes[0]["n"], Value::from(0));
    let messages = run_query(&conn, "SELECT count(*) AS n FROM chat_messages", &[]).unwrap();
    assert_eq!(messages[0]["n"], Value::from(1));
}

// ---- note_claims addressing (0019) ------------------------------------------

#[test]
fn a_filename_stem_resolves_a_note_whose_authored_title_differs() {
    let conn = migrated();
    apply_note(&conn, &note("Projects/Plan.md", "Weekly Planning", vec![])).unwrap();
    let keys = run_query(
        &conn,
        "SELECT note_path FROM note_keys WHERE key = 'plan'",
        &[],
    )
    .unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["note_path"], Value::from("Projects/Plan.md"));
}

#[test]
fn a_title_outranks_a_filename_stem_claiming_the_same_key() {
    let conn = migrated();
    apply_note(&conn, &note("Archive/old.md", "Plan", vec![])).unwrap();
    apply_note(&conn, &note("Projects/Plan.md", "Weekly", vec![])).unwrap();
    let keys = run_query(
        &conn,
        "SELECT note_path, claim_count FROM note_keys WHERE key = 'plan'",
        &[],
    )
    .unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["note_path"], Value::from("Archive/old.md"));
    // The weaker claimant does not inflate the winning tier's count.
    assert_eq!(keys[0]["claim_count"], Value::from(1));
}

#[test]
fn an_alias_outranks_a_filename_stem_but_loses_to_a_title() {
    let conn = migrated();
    apply_note(&conn, &aliased_note("notes/a.md", "Alpha", "Plan")).unwrap();
    apply_note(&conn, &note("archive/Plan.md", "Beta", vec![])).unwrap();
    let via_alias = run_query(
        &conn,
        "SELECT note_path FROM note_keys WHERE key = 'plan'",
        &[],
    )
    .unwrap();
    assert_eq!(via_alias[0]["note_path"], Value::from("notes/a.md"));

    apply_note(&conn, &note("notes/c.md", "Plan", vec![])).unwrap();
    let via_title = run_query(
        &conn,
        "SELECT note_path FROM note_keys WHERE key = 'plan'",
        &[],
    )
    .unwrap();
    assert_eq!(via_title[0]["note_path"], Value::from("notes/c.md"));
}

#[test]
fn two_files_with_one_stem_report_the_ambiguity_without_fanning_out() {
    let conn = migrated();
    apply_note(&conn, &note("b/Plan.md", "One Thing", vec![])).unwrap();
    apply_note(&conn, &note("a/Plan.md", "Another Thing", vec![])).unwrap();
    apply_note(&conn, &note("notes/src.md", "Src", vec![wiki("Plan")])).unwrap();
    let keys = run_query(
        &conn,
        "SELECT note_path, claim_count FROM note_keys WHERE key = 'plan'",
        &[],
    )
    .unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["note_path"], Value::from("a/Plan.md"));
    assert_eq!(keys[0]["claim_count"], Value::from(2));
    // Exactly one backlink row: the deterministic winner, never both.
    let backlinks = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'notes/src.md'",
        &[],
    )
    .unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["target_path"], Value::from("a/Plan.md"));
}

#[test]
fn a_path_link_backlinks_to_exactly_that_file() {
    let conn = migrated();
    apply_note(&conn, &note("Projects/Plan.md", "Weekly", vec![])).unwrap();
    apply_note(&conn, &note("notes/Plan.md", "Other", vec![])).unwrap();
    apply_note(
        &conn,
        &note(
            "Journal.md",
            "Journal",
            vec![path_link(
                LinkKind::Wiki,
                "Projects/Plan",
                "projects/plan.md",
            )],
        ),
    )
    .unwrap();
    let rows = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'Journal.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target_path"], Value::from("Projects/Plan.md"));
}

#[test]
fn a_markdown_link_backlinks_through_its_path_key() {
    let conn = migrated();
    apply_note(&conn, &note("Projects/Plan.md", "Weekly", vec![])).unwrap();
    apply_note(
        &conn,
        &note(
            "Projects/Journal.md",
            "Journal",
            vec![path_link(LinkKind::Md, "./Plan.md", "projects/plan.md")],
        ),
    )
    .unwrap();
    let rows = run_query(
        &conn,
        "SELECT target_path, kind FROM backlinks WHERE source_path = 'Projects/Journal.md'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target_path"], Value::from("Projects/Plan.md"));
    assert_eq!(rows[0]["kind"], Value::from("md"));
}

#[test]
fn a_path_link_to_a_missing_file_produces_no_backlink() {
    let conn = migrated();
    apply_note(
        &conn,
        &note(
            "Journal.md",
            "Journal",
            vec![path_link(LinkKind::Wiki, "Gone/Plan", "gone/plan.md")],
        ),
    )
    .unwrap();
    let rows = run_query(
        &conn,
        "SELECT target_path FROM backlinks WHERE source_path = 'Journal.md'",
        &[],
    )
    .unwrap();
    assert!(rows.is_empty());
}

#[test]
fn a_move_restates_the_path_derived_claims() {
    let mut conn = migrated();
    apply_note(&conn, &note("notes/old-name.md", "Kept Title", vec![])).unwrap();
    move_in_txn(&mut conn, "notes/old-name.md", "notes/new-name.md").unwrap();

    let claims = run_query(
        &conn,
        "SELECT key, tier FROM note_claims WHERE note_path = 'notes/new-name.md' ORDER BY tier",
        &[],
    )
    .unwrap();
    assert_eq!(claims.len(), 2);
    assert_eq!(claims[0]["key"], Value::from("kept title"));
    assert_eq!(claims[0]["tier"], Value::from(claim_tier::TITLE));
    assert_eq!(claims[1]["key"], Value::from("new-name"));
    assert_eq!(claims[1]["tier"], Value::from(claim_tier::BASENAME));

    let path_key = run_query(
        &conn,
        "SELECT path_key FROM notes WHERE path = 'notes/new-name.md'",
        &[],
    )
    .unwrap();
    assert_eq!(path_key[0]["path_key"], Value::from("notes/new-name.md"));
}
/// A session over a real index file: the file-backed connections, a writer
/// and a reader.
fn file_session(root: &std::path::Path) -> (IndexSession, u64) {
    let session = IndexSession::new();
    let generation = session
        .open(root, &FileIndexConnections)
        .expect("open index");
    (session, generation)
}

fn note_count(session: &IndexSession) -> Value {
    let requested = session.read_generation().unwrap();
    let rows = session
        .read(requested, |conn| {
            run_query(conn, "SELECT count(*) AS n FROM notes", &[])
        })
        .expect("count");
    rows[0]["n"].clone()
}

/// The note-window adoption contract: reading the open session must never
/// bump the generation. A bump here would strand every write the main window
/// has pinned to the current one.
#[test]
fn session_adoption_reads_never_bump_generations() {
    let graph_dir = tempfile::tempdir().expect("tempdir");
    let session = IndexSession::new();

    // Before any index opens, adoption reports that honestly (None), rather
    // than opening one itself.
    assert_eq!(session.current_generation().unwrap(), None);

    let opened = session
        .open(graph_dir.path(), &FileIndexConnections)
        .expect("open");
    for _ in 0..2 {
        assert_eq!(session.current_generation().unwrap(), Some(opened));
        assert_eq!(session.read_generation().unwrap(), opened);
    }
}

/// The generation gate that every TS write relies on: a write carrying a
/// stale generation (issued before the index was reopened) must report
/// `Stale` and leave the newly opened index untouched.
#[test]
fn stale_generation_writes_are_dropped_end_to_end() {
    let graph_dir = tempfile::tempdir().expect("tempdir");
    let (session, stale) = file_session(graph_dir.path());
    assert_eq!(
        session
            .apply(stale, &[note("notes/a.md", "A", vec![])])
            .unwrap(),
        Applied::Committed
    );
    assert_eq!(note_count(&session), Value::from(1));

    // Reopening (graph switch / reload) bumps the generation; the old one is stale.
    let fresh = session
        .open(graph_dir.path(), &FileIndexConnections)
        .expect("reopen");
    assert_ne!(stale, fresh);

    assert_eq!(
        session
            .apply(stale, &[note("notes/b.md", "B", vec![])])
            .unwrap(),
        Applied::Stale
    );
    assert_eq!(note_count(&session), Value::from(1));
    assert_eq!(session.remove(stale, "notes/a.md").unwrap(), Applied::Stale);
    assert_eq!(note_count(&session), Value::from(1));
    assert_eq!(
        session
            .apply(fresh, &[note("notes/b.md", "B", vec![])])
            .unwrap(),
        Applied::Committed
    );
    assert_eq!(note_count(&session), Value::from(2));

    // set_meta rides the same gate: stale stamps vanish, fresh ones land
    // (and upsert — the projection-version stamp is written after every rebuild).
    let meta = || {
        session
            .read(fresh, |conn| {
                run_query(conn, "SELECT value FROM index_meta WHERE key = 'k'", &[])
            })
            .expect("meta")
    };
    assert_eq!(
        session.set_meta(stale, "k", "stale").unwrap(),
        Applied::Stale
    );
    assert!(meta().is_empty());
    assert_eq!(
        session.set_meta(fresh, "k", "v1").unwrap(),
        Applied::Committed
    );
    assert_eq!(
        session.set_meta(fresh, "k", "v2").unwrap(),
        Applied::Committed
    );
    assert_eq!(meta()[0]["value"], Value::from("v2"));
}

/// A query pinned to the generation it was issued for must error, not answer
/// with another graph's rows, when the session is reopened in between.
#[test]
fn a_query_issued_before_a_reopen_errors_instead_of_crossing_graphs() {
    let graph_dir = tempfile::tempdir().expect("tempdir");
    let (session, _) = file_session(graph_dir.path());
    let requested = session.read_generation().unwrap();
    session
        .open(graph_dir.path(), &FileIndexConnections)
        .expect("reopen");
    let err = session
        .read(requested, |conn| {
            run_query(conn, "SELECT count(*) AS n FROM notes", &[])
        })
        .expect_err("stale query");
    assert_eq!(err.message(), "index reopened during query");
}

/// A host with one connection (no reader) still answers queries, on the
/// writer, under the same generation pin.
#[test]
fn a_single_connection_host_queries_on_the_writer() {
    struct OneConnection;
    impl IndexConnections for OneConnection {
        fn open_writer(&self, _root: &std::path::Path) -> reflect_types::AppResult<Connection> {
            Ok(migrated())
        }
        fn open_reader(
            &self,
            _root: &std::path::Path,
        ) -> reflect_types::AppResult<Option<Connection>> {
            Ok(None)
        }
    }
    let session = IndexSession::new();
    let generation = session
        .open(std::path::Path::new("/unused"), &OneConnection)
        .unwrap();
    session
        .apply(generation, &[note("notes/a.md", "A", vec![])])
        .unwrap();
    assert_eq!(note_count(&session), Value::from(1));
}

/// The root the shell walks for a reconcile scan comes from the session, not
/// from the caller: `root_for_generation` answers the root the generation was
/// opened for, `None` once the session moved on, and `reconcile_scan` itself
/// re-checks the generation under the lock.
#[test]
fn root_for_generation_and_reconcile_scan_follow_the_sessions_generation() {
    let graph_a = tempfile::tempdir().expect("tempdir");
    let graph_b = tempfile::tempdir().expect("tempdir");

    let (session, generation) = file_session(graph_a.path());
    assert_eq!(
        session.root_for_generation(generation).unwrap().as_deref(),
        Some(graph_a.path())
    );
    let listed = |path: &str| reflect_types::FileMeta {
        path: path.to_string(),
        size: 6,
        modified_ms: 1,
        placeholder: false,
    };
    let scan = session
        .reconcile_scan(generation, &[listed("one.md")], 10_000)
        .expect("scan");
    assert_eq!(scan.total, 1);

    // The switch's second half: a new generation opened for graph B. The
    // old generation now resolves to no root, and a scan queued for it gets
    // the empty delta, never graph B's rows.
    session
        .open(graph_b.path(), &FileIndexConnections)
        .expect("open b");
    assert_eq!(session.root_for_generation(generation).unwrap(), None);
    let scan = session
        .reconcile_scan(generation, &[listed("one.md")], 10_000)
        .expect("stale scan");
    assert_eq!(scan.total, 0);
}

/// A reader that fails to open must not leave a half-open session behind: the
/// writer is dropped too, so every later call reports `no_graph`.
#[test]
fn a_failed_reader_open_unbinds_the_writer() {
    struct ReaderFails;
    impl IndexConnections for ReaderFails {
        fn open_writer(&self, _root: &std::path::Path) -> reflect_types::AppResult<Connection> {
            Ok(migrated())
        }
        fn open_reader(
            &self,
            _root: &std::path::Path,
        ) -> reflect_types::AppResult<Option<Connection>> {
            Err(reflect_types::AppError::io("reader refused"))
        }
    }
    let session = IndexSession::new();
    let err = session
        .open(std::path::Path::new("/unused"), &ReaderFails)
        .expect_err("open fails");
    assert_eq!(err.message(), "reader refused");
    assert_eq!(session.current_generation().unwrap(), None);
    // The first open bumped the writer to generation 1; a write for it must
    // report no graph rather than land in the unbound index.
    let err = session
        .apply(1, &[note("notes/a.md", "A", vec![])])
        .expect_err("no index");
    assert_eq!(err.message(), "No graph is open");
}

fn tagged_note(path: &str, title: &str, tags: &[&str]) -> IndexedNote {
    let mut tagged = note(path, title, vec![]);
    tagged.tags = tags
        .iter()
        .map(|tag| IndexedTag {
            tag: tag.to_string(),
            tag_key: tag.to_lowercase(),
        })
        .collect();
    tagged
}

#[test]
fn meta_reads_one_key() {
    let conn = migrated();
    conn.execute("INSERT INTO index_meta(key, value) VALUES('k', 'v')", [])
        .unwrap();

    assert_eq!(meta(&conn, "k").unwrap(), Some("v".to_string()));
    assert_eq!(meta(&conn, "missing").unwrap(), None);
}

#[test]
fn graph_stats_skip_private_notes_and_cap_the_tags() {
    let conn = migrated();
    apply_note(&conn, &tagged_note("notes/a.md", "A", &["Book", "idea"])).unwrap();
    apply_note(&conn, &tagged_note("notes/b.md", "B", &["book"])).unwrap();
    let mut secret = tagged_note("notes/secret.md", "Secret", &["hidden"]);
    secret.is_private = true;
    apply_note(&conn, &secret).unwrap();
    apply_note(&conn, &daily_note("daily/2026-01-02.md", "2026-01-02")).unwrap();
    apply_note(&conn, &daily_note("daily/2026-03-04.md", "2026-03-04")).unwrap();

    let stats = graph_stats(&conn, 1).unwrap();
    assert_eq!(stats.note_count, 2);
    assert_eq!(stats.daily_note_count, 2);
    assert_eq!(stats.earliest_daily_date.as_deref(), Some("2026-01-02"));
    assert_eq!(stats.latest_daily_date.as_deref(), Some("2026-03-04"));
    assert_eq!(
        stats.tags,
        [TagFacet {
            tag: "Book".to_string(),
            count: 2
        }]
    );
    assert!(stats.tags_truncated);

    let all = graph_stats(&conn, 2).unwrap();
    assert_eq!(all.tags.len(), 2);
    assert!(!all.tags_truncated);
}

#[test]
fn read_runs_on_the_single_connection_of_a_host_without_a_reader() {
    struct OneConnection;

    impl IndexConnections for OneConnection {
        fn open_writer(&self, _root: &std::path::Path) -> reflect_types::AppResult<Connection> {
            Ok(migrated())
        }

        fn open_reader(
            &self,
            _root: &std::path::Path,
        ) -> reflect_types::AppResult<Option<Connection>> {
            Ok(None)
        }
    }

    let session = IndexSession::new();
    let generation = session
        .open(std::path::Path::new("/memory"), &OneConnection)
        .unwrap();
    session.set_meta(generation, "k", "v").unwrap();

    let value = session.read(generation, |conn| meta(conn, "k")).unwrap();
    assert_eq!(value, Some("v".to_string()));
    let stale = session.read(generation + 1, |conn| meta(conn, "k"));
    assert_eq!(stale.unwrap_err().message(), "index reopened during query");
}

#[test]
fn daily_reads_keep_the_range_and_skip_empty_and_private_days() {
    let conn = migrated();
    let mut empty = daily_note("daily/2026-06-02.md", "2026-06-02");
    empty.has_content = false;
    let mut secret = daily_note("daily/2026-06-03.md", "2026-06-03");
    secret.is_private = true;
    for daily in [
        daily_note("daily/2026-05-31.md", "2026-05-31"),
        daily_note("daily/2026-06-01.md", "2026-06-01"),
        empty,
        secret,
        daily_note("daily/2026-06-30.md", "2026-06-30"),
    ] {
        apply_note(&conn, &daily).unwrap();
    }

    assert_eq!(
        dates_in_range(&conn, "2026-06-01", "2026-06-30").unwrap(),
        ["2026-06-01", "2026-06-03", "2026-06-30"]
    );
    let dates = |limit| -> Vec<String> {
        notes_in_range(&conn, "2026-06-01", "2026-06-30", limit)
            .unwrap()
            .into_iter()
            .map(|row| row.daily_date)
            .collect()
    };
    assert_eq!(dates(10), ["2026-06-30", "2026-06-02", "2026-06-01"]);
    assert_eq!(dates(1), ["2026-06-30"]);
}

#[test]
fn chat_reads_order_conversations_by_activity_and_messages_by_seq() {
    let conn = migrated();
    let mut newer = conversation("c2");
    newer.updated_ms = 3_000;
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    save_message(&conn, &newer, &chat_message("m2", "c2")).unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m0", "c1")).unwrap();

    let ids = |limit| -> Vec<String> {
        conversations(&conn, limit)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect()
    };
    assert_eq!(ids(10), ["c2", "c1"]);
    assert_eq!(ids(1), ["c2"]);
    assert_eq!(
        messages(&conn, "c1").unwrap(),
        [chat_message("m1", "c1"), chat_message("m0", "c1")]
    );
    assert_eq!(messages(&conn, "missing").unwrap(), []);
}

#[test]
fn note_reads_map_flags_and_order_pins_and_templates() {
    let conn = migrated();
    let mut secret = note("notes/secret.md", "Secret", vec![]);
    secret.is_private = true;
    secret.gist_url = Some("https://gist.example/1".to_string());
    secret.gist_stale = true;
    let mut first = note("notes/first.md", "Zebra", vec![]);
    first.is_pinned = true;
    first.pinned_order = Some(1.0);
    let mut unordered_b = note("notes/b.md", "Beta", vec![]);
    unordered_b.is_pinned = true;
    let mut unordered_a = note("notes/a.md", "Alpha", vec![]);
    unordered_a.is_pinned = true;
    let mut template_b = note("templates/b.md", "Weekly", vec![]);
    template_b.kind = NoteKind::Template;
    template_b.is_pinned = true;
    let mut template_a = note("templates/a.md", "Daily", vec![]);
    template_a.kind = NoteKind::Template;
    for indexed in [
        &secret,
        &first,
        &unordered_b,
        &unordered_a,
        &template_b,
        &template_a,
    ] {
        apply_note(&conn, indexed).unwrap();
    }

    let row = note_row(&conn, "notes/secret.md").unwrap().unwrap();
    assert!(row.is_private && row.gist_stale);
    assert_eq!(row.gist_url.as_deref(), Some("https://gist.example/1"));
    assert_eq!(note_row(&conn, "notes/missing.md").unwrap(), None);

    let pinned: Vec<String> = pinned_notes(&conn)
        .unwrap()
        .into_iter()
        .map(|pinned| pinned.path)
        .collect();
    assert_eq!(pinned, ["notes/first.md", "notes/a.md", "notes/b.md"]);
    let listed: Vec<String> = templates(&conn)
        .unwrap()
        .into_iter()
        .map(|template| template.path)
        .collect();
    assert_eq!(listed, ["templates/a.md", "templates/b.md"]);
}

#[test]
fn list_reads_take_any_number_of_paths() {
    let conn = migrated();
    let mut with_id = note("notes/a.md", "A", vec![]);
    with_id.id = Some("one".to_string());
    apply_note(&conn, &with_id).unwrap();
    apply_note(&conn, &note("notes/b.md", "B", vec![])).unwrap();
    let mut paths: Vec<String> = (0..2_000)
        .map(|at| format!("notes/missing-{at}.md"))
        .collect();
    paths.push("notes/a.md".to_string());
    paths.push("notes/b.md".to_string());

    let mut ids = note_ids(&conn, &paths).unwrap();
    ids.sort_by(|left, right| left.path.cmp(&right.path));
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0].id.as_deref(), Some("one"));
    assert_eq!(ids[1].id, None);
    assert_eq!(file_facts(&conn, &paths).unwrap().len(), 2);
    assert_eq!(file_facts(&conn, &[]).unwrap(), []);
}

#[test]
fn resolve_target_tries_id_then_daily_then_path_title_alias() {
    let conn = migrated();
    assert_eq!(random_note(&conn).unwrap(), None);
    let mut with_id = note("notes/renamed.md", "Renamed", vec![]);
    with_id.id = Some("notes/plain.md".to_string());
    apply_note(&conn, &with_id).unwrap();
    apply_note(&conn, &note("notes/plain.md", "Plain", vec![])).unwrap();
    apply_note(&conn, &aliased_note("notes/c.md", "Cee", "Nickname")).unwrap();
    let resolve = |target: &str, daily: Option<&str>| {
        resolve_target(
            &conn,
            target,
            daily.map(String::from),
            &target.to_lowercase(),
        )
        .unwrap()
    };

    // An id wins over the path of the same text.
    assert_eq!(
        resolve("notes/plain.md", None).as_deref(),
        Some("notes/renamed.md")
    );
    assert_eq!(
        resolve("2026-01-02", Some("daily/2026-01-02.md")).as_deref(),
        Some("daily/2026-01-02.md")
    );
    assert_eq!(resolve("notes/c.md", None).as_deref(), Some("notes/c.md"));
    assert_eq!(resolve("Plain", None).as_deref(), Some("notes/plain.md"));
    assert_eq!(resolve("Nickname", None).as_deref(), Some("notes/c.md"));
    assert_eq!(resolve("nothing", None), None);
    assert!(random_note(&conn).unwrap().is_some());
}

#[test]
fn owner_reads_find_notes_by_asset_and_by_person_email() {
    let conn = migrated();
    let mut person = tagged_note("notes/ada.md", "Ada", &["person"]);
    person.emails = vec![IndexedEmail {
        email: "Ada@Example.com".to_string(),
        email_key: "ada@example.com".to_string(),
    }];
    person.assets = vec!["assets/photo.png".to_string()];
    let mut untagged = note("notes/other.md", "Other", vec![]);
    untagged.emails = vec![IndexedEmail {
        email: "ada@example.com".to_string(),
        email_key: "ada@example.com".to_string(),
    }];
    untagged.assets = vec!["photo.png".to_string()];
    let mut template = note("templates/t.md", "T", vec![]);
    template.kind = NoteKind::Template;
    for indexed in [&person, &untagged, &template] {
        apply_note(&conn, indexed).unwrap();
    }
    let keys = [
        "ada@example.com".to_string(),
        "nobody@example.com".to_string(),
    ];

    assert_eq!(
        person_owners(&conn, &keys, "person").unwrap(),
        ["notes/ada.md"]
    );
    assert_eq!(
        person_owners(&conn, &[], "person").unwrap(),
        Vec::<String>::new()
    );
    let mut owners = note_paths(
        &conn,
        &["assets/photo.png".to_string(), "photo.png".to_string()],
    )
    .unwrap();
    owners.sort();
    assert_eq!(owners, ["notes/ada.md", "notes/other.md"]);
    assert!(path_taken(&conn, "notes/ada.md").unwrap());
    assert!(!path_taken(&conn, "notes/free.md").unwrap());
    assert_eq!(
        embeddable_paths(&conn).unwrap(),
        ["notes/ada.md", "notes/other.md"]
    );
    assert_eq!(chunk_hashes(&conn, "notes/ada.md").unwrap(), []);
}

#[test]
fn note_lists_order_pins_first_and_attach_tags() {
    let conn = migrated();
    let mut old_pinned = tagged_note("notes/pinned.md", "Pinned", &["Zeta", "alpha"]);
    old_pinned.is_pinned = true;
    old_pinned.mtime = 1;
    let mut newer = tagged_note("notes/newer.md", "Newer", &["alpha"]);
    newer.mtime = 30;
    let mut older = note("notes/older.md", "Older", vec![]);
    older.mtime = 20;
    let mut secret = tagged_note("notes/secret.md", "Secret", &["alpha"]);
    secret.is_private = true;
    secret.mtime = 40;
    let mut daily = daily_note("daily/2026-01-02.md", "2026-01-02");
    daily.tags = vec![IndexedTag {
        tag: "Alpha".to_string(),
        tag_key: "alpha".to_string(),
    }];
    daily.mtime = 10;
    for indexed in [&old_pinned, &newer, &older, &secret, &daily] {
        apply_note(&conn, indexed).unwrap();
    }
    let paths = |tag: Option<&str>| -> Vec<String> {
        list_notes(&conn, tag)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect()
    };

    assert_eq!(
        paths(None),
        [
            "notes/pinned.md",
            "notes/secret.md",
            "notes/newer.md",
            "notes/older.md"
        ]
    );
    // A tag also lists the daily notes that carry it.
    assert_eq!(
        paths(Some("alpha")),
        [
            "notes/pinned.md",
            "notes/secret.md",
            "notes/newer.md",
            "daily/2026-01-02.md"
        ]
    );
    assert_eq!(paths(Some("nothing")), Vec::<String>::new());
    let all = list_notes(&conn, None).unwrap();
    assert!(all[0].is_pinned);
    assert_eq!(all[0].tags, ["alpha", "Zeta"]);
    assert_eq!(all[3].tags, Vec::<String>::new());

    let recent = |limit, tag: Option<&str>| -> Vec<String> {
        recent_notes(&conn, limit, tag)
            .unwrap()
            .into_iter()
            .map(|row| row.path)
            .collect()
    };
    assert_eq!(recent(2, None), ["notes/newer.md", "notes/older.md"]);
    assert_eq!(
        recent(5, Some("alpha")),
        ["notes/newer.md", "notes/pinned.md"]
    );

    let facets: Vec<(String, u32)> = note_tags(&conn)
        .unwrap()
        .into_iter()
        .map(|facet| (facet.tag, facet.count))
        .collect();
    assert_eq!(facets, [("alpha".to_string(), 3), ("Zeta".to_string(), 1)]);
}

#[test]
fn tasks_split_by_checked_and_skip_templates() {
    let conn = migrated();
    let mut with_tasks = note("notes/a.md", "A", vec![]);
    with_tasks.is_pinned = true;
    with_tasks.tasks = vec![task(0, "open one", false), task(1, "done one", true)];
    let mut template = note("templates/t.md", "T", vec![]);
    template.kind = NoteKind::Template;
    template.tasks = vec![task(0, "template task", false)];
    apply_note(&conn, &with_tasks).unwrap();
    apply_note(&conn, &template).unwrap();

    let open = tasks(&conn, false).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].markdown, "open one");
    assert_eq!(open[0].note_title, "A");
    assert!(open[0].is_pinned && !open[0].checked);
    let done = tasks(&conn, true).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].markdown, "done one");
}

#[test]
fn wiki_reads_resolve_keys_claims_and_link_sources() {
    let conn = migrated();
    apply_note(&conn, &note("notes/rust.md", "Rust", vec![])).unwrap();
    apply_note(&conn, &aliased_note("notes/other.md", "Other", "Rust")).unwrap();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Rust")])).unwrap();
    apply_note(
        &conn,
        &note(
            "notes/b.md",
            "B",
            vec![
                wiki("Rust"),
                path_link(LinkKind::Wiki, "notes/rust", "notes/rust.md"),
            ],
        ),
    )
    .unwrap();
    let mut template = note("templates/t.md", "T", vec![]);
    template.kind = NoteKind::Template;
    apply_note(&conn, &template).unwrap();

    // The title claims the key in a stronger tier than the alias.
    assert_eq!(
        resolve(&conn, "rust").unwrap().as_deref(),
        Some("notes/rust.md")
    );
    assert_eq!(resolve(&conn, "missing").unwrap(), None);
    let matched = claim_match(&conn, "rust").unwrap().unwrap();
    assert_eq!(matched.tier, claim_tier::TITLE);
    assert_eq!(matched.paths, ["notes/rust.md"]);
    assert_eq!(claim_match(&conn, "missing").unwrap(), None);
    assert_eq!(
        notes_by_path_key(&conn, "notes/rust.md").unwrap(),
        ["notes/rust.md"]
    );
    assert_eq!(
        link_sources(&conn, "rust").unwrap(),
        ["notes/a.md", "notes/b.md"]
    );
    assert_eq!(
        path_link_sources(&conn, "notes/rust.md").unwrap(),
        ["notes/b.md"]
    );
    let candidate = address_note(&conn, "notes/rust.md").unwrap().unwrap();
    assert_eq!(
        (candidate.title_key.as_str(), candidate.link_count),
        ("rust", 0)
    );
    assert_eq!(address_note(&conn, "templates/t.md").unwrap(), None);
}

#[test]
fn backlink_pages_run_newest_source_first_and_resume_after_a_cursor() {
    let conn = migrated();
    apply_note(&conn, &note("notes/target.md", "Target", vec![])).unwrap();
    let mut daily = daily_note("daily/2026-03-01.md", "2026-03-01");
    daily.links = vec![wiki("Target")];
    apply_note(&conn, &daily).unwrap();
    let mut twice = note(
        "notes/twice.md",
        "Twice",
        vec![wiki("Target"), wiki("Target")],
    );
    twice.links[1].pos_from = 40;
    twice.links[1].pos_to = 50;
    apply_note(&conn, &twice).unwrap();
    apply_note(&conn, &note("notes/once.md", "Once", vec![wiki("Target")])).unwrap();
    // The two notes share one recency; the path breaks the tie.
    conn.execute("UPDATE notes SET updated_at = 5000 WHERE kind = 'note'", [])
        .unwrap();

    let all = backlinks(&conn, "notes/target.md").unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].source_path, "daily/2026-03-01.md");

    let first = backlink_page(&conn, "notes/target.md", 2, None).unwrap();
    let paths: Vec<&str> = first
        .sources
        .iter()
        .map(|source| source.source_path.as_str())
        .collect();
    assert_eq!(paths, ["daily/2026-03-01.md", "notes/once.md"]);
    assert_eq!(first.indexed_link_count, 4);
    assert!(first.target_keys.contains(&"target".to_string()));
    let cursor = first.next_cursor.unwrap();
    assert_eq!(
        (cursor.recency_ms, cursor.source_path.as_str()),
        (5000, "notes/once.md")
    );

    let second = backlink_page(&conn, "notes/target.md", 2, Some(&cursor)).unwrap();
    assert_eq!(second.sources.len(), 1);
    assert_eq!(second.sources[0].source_path, "notes/twice.md");
    assert_eq!(second.sources[0].positions.len(), 2);
    assert_eq!(second.sources[0].positions[1], 40);
    assert_eq!(second.next_cursor, None);

    let unlimited = backlink_page(&conn, "notes/target.md", i64::MAX, None).unwrap();
    assert_eq!(unlimited.sources.len(), 3);
    assert_eq!(unlimited.next_cursor, None);
    let none = backlink_page(&conn, "notes/missing.md", 5, None).unwrap();
    assert_eq!((none.sources.len(), none.indexed_link_count), (0, 0));
    // A page with no source still names the keys of its target.
    apply_note(&conn, &note("notes/lonely.md", "Lonely", vec![])).unwrap();
    let lonely = backlink_page(&conn, "notes/lonely.md", 5, None).unwrap();
    assert!(lonely.sources.is_empty());
    assert!(lonely.target_keys.contains(&"lonely".to_string()));
    assert!(backlink_page(&conn, "notes/target.md", 0, None).is_err());
}

#[test]
fn suggestions_rank_exact_titles_first_and_escape_like_wildcards() {
    let conn = migrated();
    apply_note(
        &conn,
        &tagged_note("notes/rust.md", "Rust", &["Lang", "100%"]),
    )
    .unwrap();
    apply_note(
        &conn,
        &tagged_note("notes/rusty.md", "Rusty nail", &["lang"]),
    )
    .unwrap();
    apply_note(&conn, &aliased_note("notes/crab.md", "Crab", "Rustacean")).unwrap();
    apply_note(
        &conn,
        &note("notes/linker.md", "Linker", vec![wiki("Rusty nail")]),
    )
    .unwrap();
    apply_note(&conn, &daily_note("daily/2026-01-02.md", "2026-01-02")).unwrap();
    let mut template = note("templates/rust.md", "Rust template", vec![]);
    template.kind = NoteKind::Template;
    apply_note(&conn, &template).unwrap();

    let found = wiki_candidates(&conn, "rust").unwrap();
    let titles: Vec<&str> = found.titles.iter().map(|row| row.path.as_str()).collect();
    // The exact title leads, though the other note has a link.
    assert_eq!(titles, ["notes/rust.md", "notes/rusty.md"]);
    assert_eq!(found.titles[1].link_count, 1);
    assert_eq!(found.aliases.len(), 1);
    assert_eq!(found.aliases[0].alias, "Rustacean");

    // An empty key lists notes, without days and without aliases.
    let unqueried = wiki_candidates(&conn, "").unwrap();
    assert!(unqueried.titles.iter().all(|row| row.daily_date.is_none()));
    assert_eq!(unqueried.titles.len(), 4);
    assert_eq!(unqueried.aliases, []);
    // `%` is a literal, not a wildcard.
    assert_eq!(wiki_candidates(&conn, "%").unwrap().titles, []);

    let names = |key: &str, limit| -> Vec<(String, u32)> {
        suggest_tags(&conn, key, limit)
            .unwrap()
            .into_iter()
            .map(|facet| (facet.tag, facet.count))
            .collect()
    };
    assert_eq!(names("", 1), [("Lang".to_string(), 2)]);
    assert_eq!(names("0%", 5), [("100%".to_string(), 1)]);
    assert_eq!(names("_", 5), []);

    let keys = [
        "rust".to_string(),
        "rustacean".to_string(),
        "none".to_string(),
    ];
    let mut winners = key_winners(&conn, &keys).unwrap();
    winners.sort_by(|left, right| left.key.cmp(&right.key));
    let won: Vec<(&str, &str, i64)> = winners
        .iter()
        .map(|winner| {
            (
                winner.key.as_str(),
                winner.path.as_str(),
                winner.claim_count,
            )
        })
        .collect();
    assert_eq!(
        won,
        [
            ("rust", "notes/rust.md", 1),
            ("rustacean", "notes/crab.md", 1)
        ]
    );
    let aliases = winning_aliases(&conn, &["notes/crab.md".to_string()]).unwrap();
    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0].alias, "Rustacean");
}

#[test]
fn vector_reads_find_the_nearest_chunks_and_keep_private_notes_out_of_related() {
    let conn = migrated();
    index_note(&conn, "notes/self.md");
    index_note(&conn, "notes/near.md");
    let mut secret = note("notes/secret.md", "Secret", vec![]);
    secret.is_private = true;
    apply_note(&conn, &secret).unwrap();
    let mut far = vec384(0.0);
    far[0] = 1.0;
    // The note has two chunks that point in different directions; each one
    // seeds its own neighbour list.
    let mut second = vec384(0.0);
    second[1] = 1.0;
    let mut second_chunk = chunk("s2", Some(second.clone()));
    second_chunk.pos_from = 20;
    apply_chunks(
        &conn,
        "notes/self.md",
        &[chunk("s1", Some(vec384(0.5))), second_chunk],
    )
    .unwrap();
    index_note(&conn, "notes/other.md");
    second[2] = 0.1;
    apply_chunks(&conn, "notes/other.md", &[chunk("o1", Some(second))]).unwrap();
    let mut near = vec384(0.5);
    near[0] = 0.1;
    apply_chunks(&conn, "notes/near.md", &[chunk("n1", Some(near))]).unwrap();
    apply_chunks(&conn, "notes/secret.md", &[chunk("x1", Some(far.clone()))]).unwrap();

    let related = related_chunks(&conn, "notes/self.md", 16, 24).unwrap();
    let nearest_two = |list: &[reflect_types::ChunkHit]| -> Vec<String> {
        list.iter().take(2).map(|hit| hit.path.clone()).collect()
    };
    assert_eq!(related.len(), 2);
    assert_eq!(nearest_two(&related[0]), ["notes/self.md", "notes/near.md"]);
    assert_eq!(
        nearest_two(&related[1]),
        ["notes/self.md", "notes/other.md"]
    );
    assert!(related[0][0].distance.abs() < 1e-6);
    assert!(related.iter().flatten().all(|hit| !hit.is_private));
    assert_eq!(
        related_chunks(&conn, "notes/self.md", 1, 24).unwrap().len(),
        1
    );
    assert_eq!(
        related_chunks(&conn, "notes/missing.md", 16, 24)
            .unwrap()
            .len(),
        0
    );

    let nearest = semantic_chunks(&conn, &far, 1).unwrap();
    assert_eq!(nearest.len(), 1);
    assert_eq!(nearest[0].path, "notes/secret.md");
    assert!(nearest[0].is_private);

    let mut flags = privacy(
        &conn,
        &["notes/secret.md".to_string(), "notes/near.md".to_string()],
    )
    .unwrap();
    flags.sort_by(|left, right| left.path.cmp(&right.path));
    let flags: Vec<(&str, bool)> = flags
        .iter()
        .map(|flag| (flag.path.as_str(), flag.is_private))
        .collect();
    assert_eq!(flags, [("notes/near.md", false), ("notes/secret.md", true)]);
}

fn search_paths(conn: &Connection, request: &SearchRequest) -> Vec<String> {
    search(conn, request)
        .unwrap()
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn text_search(text: &str) -> SearchRequest {
    SearchRequest {
        text: text.to_string(),
        title_key: text.to_lowercase(),
        ..SearchRequest::default()
    }
}

#[test]
fn search_ranks_title_matches_before_body_hits() {
    let conn = migrated();
    let mut exact = note("notes/car.md", "Car", vec![]);
    exact.mtime = 1;
    let mut prefix = note("notes/car-log.md", "Car log", vec![]);
    prefix.mtime = 2;
    let mut word = note("notes/red-car.md", "Red car", vec![]);
    word.mtime = 3;
    let mut body = note("notes/trip.md", "Trip", vec![]);
    body.text = "we took the car".to_string();
    body.mtime = 4;
    // `car` never matches inside a word.
    let mut inside = note("notes/oscar.md", "Oscar party", vec![]);
    inside.mtime = 5;
    let mut template = note("templates/car.md", "Car", vec![]);
    template.kind = NoteKind::Template;
    for indexed in [&exact, &prefix, &word, &body, &inside, &template] {
        apply_note(&conn, indexed).unwrap();
    }

    assert_eq!(
        search_paths(&conn, &text_search("car")),
        [
            "notes/car.md",
            "notes/car-log.md",
            "notes/red-car.md",
            "notes/trip.md"
        ]
    );
    let hits = search(&conn, &text_search("car")).unwrap();
    // A body hit carries a marked snippet; the marker frames the match.
    let snippet = hits[3].snippet.as_deref().unwrap();
    assert!(snippet.contains("\u{1}car\u{2}"), "{snippet:?}");
    let limited = SearchRequest {
        limit: Some(2),
        ..text_search("car")
    };
    assert_eq!(search_paths(&conn, &limited).len(), 2);
    // The FTS pass runs once, not once per note.
    let plan = ranked_query_plan(&conn, &text_search("car")).unwrap();
    assert!(
        plan.iter().any(|step| step.contains("MATERIALIZE lexical")),
        "{plan:?}"
    );
    // User text is a literal: FTS operators and quotes are not syntax.
    assert_eq!(
        search_paths(&conn, &text_search("\"car AND NOT (")),
        Vec::<String>::new()
    );
}

#[test]
fn search_without_text_is_a_filtered_recall_feed() {
    let conn = migrated();
    let mut pinned = tagged_note("notes/pinned.md", "Pinned", &["a"]);
    pinned.is_pinned = true;
    pinned.mtime = 10;
    let mut both = tagged_note("notes/both.md", "Both", &["a", "b"]);
    both.mtime = 30;
    both.links = vec![wiki("Pinned")];
    let mut only_b = tagged_note("notes/only-b.md", "Only b", &["b"]);
    only_b.mtime = 20;
    let mut daily = daily_note("daily/2026-01-02.md", "2026-01-02");
    daily.tags = vec![IndexedTag {
        tag: "a".to_string(),
        tag_key: "a".to_string(),
    }];
    daily.mtime = 40;
    for indexed in [&pinned, &both, &only_b, &daily] {
        apply_note(&conn, indexed).unwrap();
    }
    let tags = |keys: &[&str]| keys.iter().map(|key| key.to_string()).collect::<Vec<_>>();

    assert_eq!(
        search_paths(&conn, &SearchRequest::default()),
        [
            "daily/2026-01-02.md",
            "notes/both.md",
            "notes/only-b.md",
            "notes/pinned.md"
        ]
    );
    let pinned_first = SearchRequest {
        pinned_first: true,
        notes_only: true,
        ..SearchRequest::default()
    };
    assert_eq!(
        search_paths(&conn, &pinned_first),
        ["notes/pinned.md", "notes/both.md", "notes/only-b.md"]
    );
    // Tags are ANDed.
    let tagged = |keys: &[&str]| SearchRequest {
        tag_keys: tags(keys),
        ..SearchRequest::default()
    };
    assert_eq!(
        search_paths(&conn, &tagged(&["a"])),
        ["daily/2026-01-02.md", "notes/both.md", "notes/pinned.md"]
    );
    assert_eq!(search_paths(&conn, &tagged(&["a", "b"])), ["notes/both.md"]);
    // The daily filter wins over the notes-only population.
    let dailies = SearchRequest {
        daily_only: true,
        notes_only: true,
        ..SearchRequest::default()
    };
    assert_eq!(search_paths(&conn, &dailies), ["daily/2026-01-02.md"]);
    let links_to = SearchRequest {
        links_to_path: Some("notes/pinned.md".to_string()),
        ..SearchRequest::default()
    };
    assert_eq!(search_paths(&conn, &links_to), ["notes/both.md"]);
    let linked_from = SearchRequest {
        linked_from_path: Some("notes/both.md".to_string()),
        ..SearchRequest::default()
    };
    assert_eq!(search_paths(&conn, &linked_from), ["notes/pinned.md"]);
    let window = SearchRequest {
        updated_after_ms: Some(20.0),
        updated_before_ms: Some(40.0),
        pinned_only: false,
        ..SearchRequest::default()
    };
    assert_eq!(
        search_paths(&conn, &window),
        ["notes/both.md", "notes/only-b.md"]
    );
    let only_pinned = SearchRequest {
        pinned_only: true,
        ..tagged(&["a"])
    };
    assert_eq!(search_paths(&conn, &only_pinned), ["notes/pinned.md"]);
}

// The SQL text of each query that changes with its arguments. A change in a
// text fails its test; `UPDATE_EXPECT=1 cargo test -p reflect-index` writes
// the new text into the test.

/// The clauses that start a line in the text of a statement.
const CLAUSES: [&str; 13] = [
    "SELECT ",
    "FROM ",
    "WHERE ",
    "AND ",
    "OR ",
    "INNER JOIN ",
    "LEFT JOIN ",
    "GROUP BY ",
    "ORDER BY ",
    "LIMIT ",
    "WHEN ",
    "THEN ",
    "ELSE ",
];

/// `sql` with one clause per line, indented by the depth of its parentheses.
/// The text of a quoted string stays as it is.
fn layout(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() * 2);
    let mut depth = 0;
    let mut quoted = false;
    for (at, character) in sql.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            ' ' if !quoted => {
                let rest = &sql[at + 1..];
                if CLAUSES.iter().any(|clause| rest.starts_with(clause)) {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                    continue;
                }
            }
            _ => {}
        }
        out.push(character);
    }
    out
}

/// Checks the SQL text of `statement`, one clause per line, and then its
/// bound values in placeholder order.
fn check_sql(statement: &impl QueryStatementWriter, expected: Expect) {
    let (sql, values) = statement.build(SqliteQueryBuilder);
    expected.assert_eq(&format!("{}\n{:?}", layout(&sql), values.0));
}

#[test]
fn layout_breaks_at_clauses_outside_strings() {
    assert_eq!(
        layout("SELECT a FROM t WHERE b IN (SELECT c FROM u WHERE d = ' FROM x') AND e LIMIT ?"),
        "SELECT a\n  FROM t\n  WHERE b IN (SELECT c\n    FROM u\n    WHERE d = ' FROM x')\n  AND e\n  LIMIT ?",
    );
}

#[test]
fn list_notes_sql_lists_every_note() {
    check_sql(
        &list_notes_query(None),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."mtime", "notes"."preview", "notes"."is_pinned"
              FROM "notes"
              WHERE "notes"."kind" = 'note'
              ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC
            []"#]],
    );
}

#[test]
fn list_notes_sql_lists_the_notes_of_a_tag() {
    check_sql(
        &list_notes_query(Some("a")),
        expect![[r#"
            SELECT DISTINCT "notes"."path", "notes"."title", "notes"."mtime", "notes"."preview", "notes"."is_pinned", "notes"."pinned_order"
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              WHERE "tags"."tag_key" = ?
              AND "notes"."kind" IN ('note', 'daily')
              ORDER BY "notes"."is_pinned" DESC, "notes"."pinned_order" IS NULL ASC, "notes"."pinned_order" ASC, "notes"."mtime" DESC, "notes"."path" ASC
            [String(Some("a"))]"#]],
    );
}

#[test]
fn list_tags_sql_reads_the_tags_of_every_note() {
    check_sql(
        &list_tags_query(None),
        expect![[r#"
            SELECT "tags"."note_path", "tags"."tag"
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              WHERE "notes"."kind" = 'note'
              ORDER BY "tags"."tag_key" ASC
            []"#]],
    );
}

#[test]
fn list_tags_sql_reads_the_tags_of_the_notes_of_a_tag() {
    check_sql(
        &list_tags_query(Some("a")),
        expect![[r#"
            SELECT DISTINCT "tags"."note_path", "tags"."tag"
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              INNER JOIN "tags" AS "filter_tags" ON "filter_tags"."note_path" = "notes"."path"
              WHERE "filter_tags"."tag_key" = ?
              AND "notes"."kind" IN ('note', 'daily')
              ORDER BY "tags"."tag_key" ASC
            [String(Some("a"))]"#]],
    );
}

#[test]
fn recent_notes_sql_lists_every_note() {
    check_sql(
        &recent_notes_query(5, None),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."preview", "notes"."mtime", "notes"."is_private"
              FROM "notes"
              WHERE "notes"."kind" = 'note'
              AND "notes"."is_private" = 0
              ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
              LIMIT ?
            [BigUnsigned(Some(5))]"#]],
    );
}

#[test]
fn recent_notes_sql_lists_the_notes_of_a_tag() {
    check_sql(
        &recent_notes_query(5, Some("a")),
        expect![[r#"
            SELECT DISTINCT "notes"."path", "notes"."title", "notes"."preview", "notes"."mtime", "notes"."is_private"
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              WHERE "tags"."tag_key" = ?
              AND "notes"."kind" = 'note'
              AND "notes"."is_private" = 0
              ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
              LIMIT ?
            [String(Some("a")), BigUnsigned(Some(5))]"#]],
    );
}

fn cursor() -> BacklinkSourceCursor {
    BacklinkSourceCursor {
        recency_ms: 100,
        source_path: "notes/a.md".to_string(),
    }
}

#[test]
fn backlink_page_sql_reads_the_first_page() {
    check_sql(
        &page_sources_query("notes/car.md", 5, None),
        expect![[r#"
            SELECT DISTINCT "source_path", "source_title", "recency"
              FROM (SELECT "backlinks"."source_path" AS "source_path", "notes"."title" AS "source_title", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
                FROM "backlinks"
                INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
                WHERE "backlinks"."target_path" = ?) AS "sources"
              WHERE TRUE
              ORDER BY "recency" DESC, "source_path" ASC
              LIMIT ?
            [String(Some("notes/car.md")), BigUnsigned(Some(6))]"#]],
    );
}

#[test]
fn backlink_page_sql_reads_the_page_after_a_cursor() {
    check_sql(
        &page_sources_query("notes/car.md", 5, Some(&cursor())),
        expect![[r#"
            SELECT DISTINCT "source_path", "source_title", "recency"
              FROM (SELECT "backlinks"."source_path" AS "source_path", "notes"."title" AS "source_title", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
                FROM "backlinks"
                INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
                WHERE "backlinks"."target_path" = ?) AS "sources"
              WHERE "recency" < ?
              OR ("recency" = ?
                AND "source_path" > ?)
              ORDER BY "recency" DESC, "source_path" ASC
              LIMIT ?
            [String(Some("notes/car.md")), BigInt(Some(100)), BigInt(Some(100)), String(Some("notes/a.md")), BigUnsigned(Some(6))]"#]],
    );
}

#[test]
fn backlink_positions_sql_reads_the_first_page() {
    check_sql(
        &page_positions_query("notes/car.md", None, &cursor()),
        expect![[r#"
            SELECT "source_path", "pos_from"
              FROM (SELECT "backlinks"."source_path" AS "source_path", "backlinks"."pos_from" AS "pos_from", COALESCE(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at") AS "recency"
                FROM "backlinks"
                INNER JOIN "notes" ON "notes"."path" = "backlinks"."source_path"
                WHERE "backlinks"."target_path" = ?) AS "sources"
              WHERE "recency" > ?
              OR ("recency" = ?
                AND "source_path" <= ?)
              ORDER BY "recency" DESC, "source_path" ASC, "pos_from" ASC
            [String(Some("notes/car.md")), BigInt(Some(100)), BigInt(Some(100)), String(Some("notes/a.md"))]"#]],
    );
}

#[test]
fn backlink_positions_sql_reads_the_page_after_a_cursor() {
    check_sql(
        &page_positions_query("notes/car.md", Some(&cursor()), &cursor()),
        expect![[r#"
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
              ORDER BY "recency" DESC, "source_path" ASC, "pos_from" ASC
            [String(Some("notes/car.md")), BigInt(Some(100)), BigInt(Some(100)), String(Some("notes/a.md")), BigInt(Some(100)), BigInt(Some(100)), String(Some("notes/a.md"))]"#]],
    );
}

#[test]
fn suggest_tags_sql_lists_every_tag() {
    check_sql(
        &tags_query("", 5),
        expect![[r#"
            SELECT MIN("tags"."tag"), COUNT(*)
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              WHERE "notes"."kind" <> 'template'
              GROUP BY "tags"."tag_key"
              ORDER BY COUNT(*) DESC, MIN("tags"."tag") ASC
              LIMIT ?
            [BigUnsigned(Some(5))]"#]],
    );
}

#[test]
fn suggest_tags_sql_lists_the_tags_with_a_key() {
    check_sql(
        &tags_query("a", 5),
        expect![[r#"
            SELECT MIN("tags"."tag"), COUNT(*)
              FROM "tags"
              INNER JOIN "notes" ON "notes"."path" = "tags"."note_path"
              WHERE "notes"."kind" <> 'template'
              AND "tags"."tag_key" LIKE ? ESCAPE '\'
              GROUP BY "tags"."tag_key"
              ORDER BY COUNT(*) DESC, MIN("tags"."tag") ASC
              LIMIT ?
            [String(Some("%a%")), BigUnsigned(Some(5))]"#]],
    );
}

#[test]
fn title_candidates_sql_lists_notes_for_no_key() {
    check_sql(
        &title_candidates_query(""),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", (SELECT COUNT(*)
                FROM "note_claims"
                INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
                WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
              FROM "notes"
              WHERE "notes"."kind" <> 'template'
              AND "notes"."daily_date" IS NULL
              ORDER BY "notes"."title_key" = ? DESC, "notes"."title_key" LIKE ? ESCAPE '\' DESC, "link_count" DESC, "notes"."mtime" DESC
              LIMIT ?
            [String(Some("")), String(Some("%%")), BigUnsigned(Some(200))]"#]],
    );
}

#[test]
fn title_candidates_sql_matches_a_key_in_titles_and_the_search_index() {
    check_sql(
        &title_candidates_query("car"),
        expect![[r#"
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
              LIMIT ?
            [String(Some("%car%")), String(Some("title : \"car\"*")), String(Some("car")), String(Some("%car%")), BigUnsigned(Some(200))]"#]],
    );
}

#[test]
fn title_candidates_sql_matches_a_key_with_no_search_term_in_titles() {
    check_sql(
        &title_candidates_query("%"),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."title_key", "notes"."daily_date", "notes"."mtime", (SELECT COUNT(*)
                FROM "note_claims"
                INNER JOIN "links" ON "links"."target_key" = "note_claims"."key"
                WHERE "note_claims"."note_path" = "notes"."path") AS "link_count"
              FROM "notes"
              WHERE "notes"."kind" <> 'template'
              AND "notes"."title_key" LIKE ? ESCAPE '\'
              ORDER BY "notes"."title_key" = ? DESC, "notes"."title_key" LIKE ? ESCAPE '\' DESC, "link_count" DESC, "notes"."mtime" DESC
              LIMIT ?
            [String(Some("%\\%%")), String(Some("%")), String(Some("%\\%%")), BigUnsigned(Some(200))]"#]],
    );
}

/// A search request with every filter.
fn filtered_search(text: &str) -> SearchRequest {
    SearchRequest {
        tag_keys: vec!["a".to_string(), "b".to_string()],
        notes_only: true,
        pinned_only: true,
        links_to_path: Some("notes/car.md".to_string()),
        linked_from_path: Some("notes/trip.md".to_string()),
        updated_after_ms: Some(1.0),
        updated_before_ms: Some(100.0),
        pinned_first: true,
        limit: Some(20),
        ..text_search(text)
    }
}

#[test]
fn recall_sql_lists_every_note() {
    check_sql(
        &recall_query(&SearchRequest::default()),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
              FROM "notes"
              WHERE "notes"."kind" <> 'template'
              ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
            []"#]],
    );
}

#[test]
fn recall_sql_lists_daily_notes() {
    let request = SearchRequest {
        daily_only: true,
        ..SearchRequest::default()
    };
    check_sql(
        &recall_query(&request),
        expect![[r#"
            SELECT "notes"."path", "notes"."title", "notes"."daily_date", "notes"."preview", "notes"."mtime", "notes"."is_pinned"
              FROM "notes"
              WHERE "notes"."kind" <> 'template'
              AND "notes"."daily_date" IS NOT NULL
              ORDER BY "notes"."mtime" DESC, "notes"."path" ASC
            []"#]],
    );
}

#[test]
fn recall_sql_applies_every_filter() {
    check_sql(
        &recall_query(&filtered_search("")),
        expect![[r#"
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
              LIMIT ?
            [String(Some("a")), String(Some("b")), String(Some("notes/car.md")), String(Some("notes/trip.md")), Double(Some(1.0)), Double(Some(100.0)), BigUnsigned(Some(20))]"#]],
    );
}

fn ranked_sql(request: &SearchRequest, exclude_private: bool, expected: Expect) {
    let options = RankedOptions {
        exclude_private,
        snippet_tokens: 10,
    };
    let fts_match = build_fts_match(&request.text).unwrap();
    check_sql(&ranked_query(request, fts_match, options), expected);
}

#[test]
fn ranked_sql_matches_text() {
    ranked_sql(
        &text_search("car trip"),
        false,
        expect![[r#"
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
                ELSE 3 END) ASC, "score" ASC, "fn"."is_pinned" DESC, "fn"."mtime" DESC, "fn"."path" ASC
            [String(Some("\u{1}")), String(Some("\u{2}")), String(Some("\u{1}")), String(Some("\u{2}")), String(Some("(title : \"car\"* OR body : \"car\"*) AND (title : \"trip\"* OR body : \"trip\"*)")), String(Some("\u{1}")), String(Some(" car")), String(Some(" trip")), String(Some(" car")), String(Some(" trip")), String(Some("car trip")), String(Some("car trip")), String(Some(" car")), String(Some(" trip"))]"#]],
    );
}

#[test]
fn ranked_sql_applies_every_filter_and_skips_private_notes() {
    ranked_sql(
        &filtered_search("car trip"),
        true,
        expect![[r#"
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
                AND "notes"."is_private" = 0
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
              LIMIT ?
            [String(Some("\u{1}")), String(Some("\u{2}")), String(Some("\u{1}")), String(Some("\u{2}")), String(Some("(title : \"car\"* OR body : \"car\"*) AND (title : \"trip\"* OR body : \"trip\"*)")), String(Some("\u{1}")), String(Some(" car")), String(Some(" trip")), String(Some("a")), String(Some("b")), String(Some("notes/car.md")), String(Some("notes/trip.md")), Double(Some(1.0)), Double(Some(100.0)), String(Some(" car")), String(Some(" trip")), String(Some("car trip")), String(Some("car trip")), String(Some(" car")), String(Some(" trip")), BigUnsigned(Some(20))]"#]],
    );
}
