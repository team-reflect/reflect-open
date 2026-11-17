//! The snapshot of every SQL statement the index runs: `statements.sql`.
//!
//! Each case runs one command and records the statements it prepares. A
//! change in the text of any statement fails the test, until
//! `UPDATE_SNAPSHOTS=1 cargo test -p reflect-index statements` writes the
//! file again.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::{Value, json};

use reflect_types::{AppResult, FileMeta, SearchRequest};

use crate::read::search::{RankedOptions, search_ranked};
use crate::tests::migrated;
use crate::{
    INDEX_READ_COMMANDS, INDEX_WRITE_COMMANDS, IndexCommands, IndexConnections, IndexEvents,
    IndexSession,
};

const SNAPSHOT: &str = include_str!("statements.sql");

/// The clauses that start a line of a statement in the snapshot.
const CLAUSES: [&str; 16] = [
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
    "VALUES ",
    "SET ",
    "ON CONFLICT ",
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
                let after_delete = sql[..at].ends_with("DELETE");
                if !after_delete && CLAUSES.iter().any(|clause| rest.starts_with(clause)) {
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

/// One connection that records the text of each statement it runs.
struct Recorded(Arc<Mutex<Vec<String>>>);

impl IndexConnections for Recorded {
    fn open_writer(&self, _root: &Path) -> AppResult<Connection> {
        let mut conn = migrated();
        let statements = Arc::clone(&self.0);
        conn.trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(move |event: TraceEvent<'_>| {
                if let TraceEvent::Stmt(statement, _) = event {
                    statements.lock().unwrap().push(statement.sql().to_string());
                }
            }),
        )?;
        Ok(conn)
    }

    fn open_reader(&self, _root: &Path) -> AppResult<Option<Connection>> {
        Ok(None)
    }
}

struct NoEvents;

impl IndexEvents for NoEvents {
    fn index_written(&self) {}
    fn note_moved(&self, _from: &str, _to: &str) {}
}

/// Whether `sql` is a statement of this crate: not a transaction boundary,
/// not a statement that a trigger or a virtual table runs for itself.
fn is_own_statement(sql: &str) -> bool {
    let internal = ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "--"];
    let virtual_table_names = ["search_fts_", "embedding_vectors_", "'main'."];
    !internal.iter().any(|prefix| sql.starts_with(prefix))
        && !virtual_table_names.iter().any(|name| sql.contains(name))
}

/// Runs cases on one index and writes the snapshot text.
struct Snapshot {
    session: IndexSession,
    generation: u64,
    statements: Arc<Mutex<Vec<String>>>,
    commands: BTreeSet<String>,
    text: String,
}

impl Snapshot {
    fn new() -> Self {
        let statements = Arc::default();
        let session = IndexSession::new();
        let generation = session
            .open(Path::new("/unused"), &Recorded(Arc::clone(&statements)))
            .unwrap();
        statements.lock().unwrap().clear();
        Self {
            session,
            generation,
            statements,
            commands: BTreeSet::new(),
            text: String::new(),
        }
    }

    /// Writes the section `title` with each different statement since the
    /// last section, in the order of the first run.
    fn section(&mut self, title: &str) {
        let statements = std::mem::take(&mut *self.statements.lock().unwrap());
        let mut written = BTreeSet::new();
        writeln!(self.text, "-- {title}").unwrap();
        for sql in statements {
            if is_own_statement(&sql) && written.insert(sql.clone()) {
                writeln!(self.text, "{};", layout(sql.trim_end_matches(';'))).unwrap();
            }
        }
        self.text.push('\n');
    }

    /// Runs `command` with `args`. `variant` names the case when a command
    /// has more than one.
    fn command(&mut self, command: &str, variant: &str, args: Value) {
        let commands = IndexCommands::new(&self.session, &NoEvents, self.generation);
        commands
            .dispatch(command, args.to_string().as_bytes())
            .unwrap_or_else(|error| panic!("{command}: {error:?}"));
        self.commands.insert(command.to_string());
        if variant.is_empty() {
            self.section(command);
        } else {
            self.section(&format!("{command}: {variant}"));
        }
    }

    /// Runs a write `command`: `args` and the generation of the session.
    fn write(&mut self, command: &str, variant: &str, mut args: Value) {
        args["generation"] = json!(self.generation);
        self.command(command, variant, args);
    }
}

fn note(path: &str, title: &str) -> Value {
    let key = title.to_lowercase();
    json!({
        "path": path,
        "id": "id-1",
        "title": title,
        "titleKey": key,
        "pathKey": path.to_lowercase(),
        "kind": "note",
        "dailyDate": null,
        "isPrivate": false,
        "isPinned": true,
        "pinnedOrder": 1.0,
        "hasContent": true,
        "gistUrl": null,
        "gistStale": false,
        "fileHash": "hash",
        "mtime": 10,
        "text": "we took the car",
        "assetText": "",
        "preview": "we took the car",
        "links": [{
            "kind": "wiki", "targetRaw": "Car", "targetKey": "car", "targetPathKey": null,
            "alias": null, "posFrom": 0, "posTo": 7,
        }],
        "tags": [{ "tag": "a", "tagKey": "a" }],
        "aliases": [{ "alias": "Auto", "aliasKey": "auto" }],
        "claims": [{ "key": key, "tier": 2 }, { "key": "auto", "tier": 3 }],
        "emails": [{ "email": "a@example.com", "emailKey": "a@example.com" }],
        "assets": ["assets/a.png"],
        "tasks": [{
            "astPath": "[0]", "markdown": "- [ ] open", "breadcrumbs": [], "checked": false,
            "dueDate": null,
        }],
    })
}

fn chunk(hash: &str, with_vector: bool) -> Value {
    json!({
        "heading": null,
        "posFrom": 0,
        "posTo": 10,
        "text": "text",
        "contentHash": hash,
        "modelId": "model",
        "vector": with_vector.then(|| vec![0.1_f32; 384]),
    })
}

fn chat_message() -> Value {
    json!({
        "conversation": { "id": "c1", "title": "Title", "createdMs": 1, "updatedMs": 1 },
        "message": {
            "id": "m1", "conversationId": "c1", "userText": "hello", "attachments": "[]",
            "parts": "[]", "responseMessages": "[]", "createdMs": 1,
        },
    })
}

/// A search request with every filter.
fn filtered_search(text: &str) -> Value {
    json!({
        "text": text,
        "titleKey": text,
        "tagKeys": ["a", "b"],
        "dailyOnly": false,
        "notesOnly": true,
        "pinnedOnly": true,
        "linksToPath": "notes/car.md",
        "linkedFromPath": "notes/trip.md",
        "updatedAfterMs": 1.0,
        "updatedBeforeMs": 100.0,
        "pinnedFirst": true,
        "limit": 20,
    })
}

fn search(request: Value) -> Value {
    let mut all = json!({
        "text": "", "titleKey": "", "tagKeys": [], "dailyOnly": false, "notesOnly": false,
        "pinnedOnly": false, "linksToPath": null, "linkedFromPath": null,
        "updatedAfterMs": null, "updatedBeforeMs": null, "pinnedFirst": false, "limit": null,
    });
    for (key, value) in request.as_object().unwrap() {
        all[key] = value.clone();
    }
    json!({ "request": all })
}

fn write_cases(snapshot: &mut Snapshot) {
    let paths = json!(["notes/car.md", "notes/trip.md"]);
    snapshot.write(
        "index_apply",
        "",
        json!({ "note": note("notes/trip.md", "Trip") }),
    );
    snapshot.write(
        "index_apply_batch",
        "",
        json!({ "notes": [note("notes/car.md", "Car")] }),
    );
    snapshot.write(
        "index_touch",
        "",
        json!({ "entries": [{ "path": "notes/car.md", "mtime": 20 }] }),
    );
    snapshot.write("index_meta_set", "", json!({ "key": "k", "value": "v" }));
    snapshot.write("chat_message_save", "", chat_message());
    snapshot.write(
        "embed_apply",
        "new chunks",
        json!({ "path": "notes/car.md", "chunks": [chunk("h1", true), chunk("h2", true)] }),
    );
    snapshot.write(
        "embed_apply",
        "a kept chunk and a stale chunk",
        json!({ "path": "notes/car.md", "chunks": [chunk("h1", false)] }),
    );
    read_cases(snapshot, &paths);
    snapshot.write(
        "index_move",
        "",
        json!({
            "from": "notes/trip.md",
            "to": "daily/2026-01-02.md",
            "toAddress": {
                "pathKey": "daily/2026-01-02.md", "basenameKey": "2026-01-02",
                "dailyDate": "2026-01-02",
            },
        }),
    );
    snapshot.write("embed_remove", "", json!({ "path": "notes/car.md" }));
    snapshot.write("chat_conversation_delete", "", json!({ "id": "c1" }));
    snapshot.write("index_remove", "", json!({ "path": "notes/car.md" }));
    snapshot.write("index_clear", "", json!({}));
}

fn read_cases(snapshot: &mut Snapshot, paths: &Value) {
    let path = json!({ "path": "notes/car.md" });
    let range = json!({ "start": "2026-01-01", "end": "2026-01-31" });

    snapshot.command("index_meta_get", "", json!({ "key": "k" }));
    snapshot.command("index_graph_stats", "", json!({ "tagLimit": 5 }));
    snapshot.command("index_note", "", path.clone());
    snapshot.command("index_pinned_notes", "", json!({}));
    snapshot.command("index_templates", "", json!({}));
    snapshot.command("index_file_facts", "", json!({ "paths": paths }));
    snapshot.command("index_note_ids", "", json!({ "paths": paths }));
    snapshot.command("index_note_privacy", "", json!({ "paths": paths }));
    snapshot.command("index_random_note", "", json!({}));
    snapshot.command(
        "index_resolve_target",
        "no match, every lookup runs",
        json!({ "target": "none", "dailyPath": null, "key": "none" }),
    );
    snapshot.command("index_path_taken", "", path.clone());
    snapshot.command(
        "index_asset_owners",
        "",
        json!({ "assetPaths": ["assets/a.png"] }),
    );
    snapshot.command(
        "index_person_owners",
        "",
        json!({ "emailKeys": ["a@example.com"], "tagKey": "a" }),
    );
    snapshot.command("index_embeddable_paths", "", json!({}));
    snapshot.command("index_list_notes", "every note", json!({ "tagKey": null }));
    snapshot.command("index_list_notes", "one tag", json!({ "tagKey": "a" }));
    snapshot.command(
        "index_recent_notes",
        "every note",
        json!({ "limit": 5, "tagKey": null }),
    );
    snapshot.command(
        "index_recent_notes",
        "one tag",
        json!({ "limit": 5, "tagKey": "a" }),
    );
    snapshot.command("index_note_tags", "", json!({}));
    snapshot.command("index_tasks", "open", json!({ "checked": false }));
    snapshot.command("index_tasks", "completed", json!({ "checked": true }));
    snapshot.command("index_daily_dates", "", range.clone());
    let mut daily_notes = range;
    daily_notes["limit"] = json!(5);
    snapshot.command("index_daily_notes", "", daily_notes);

    snapshot.command("index_resolve_wiki", "", json!({ "key": "car" }));
    snapshot.command("index_wiki_target_match", "", json!({ "key": "car" }));
    snapshot.command(
        "index_notes_by_path_key",
        "",
        json!({ "pathKey": "notes/car.md" }),
    );
    snapshot.command("index_link_sources", "", json!({ "targetKey": "car" }));
    snapshot.command(
        "index_path_link_sources",
        "",
        json!({ "targetPathKey": "notes/car.md" }),
    );
    snapshot.command("index_wiki_address_note", "", path.clone());
    snapshot.command("index_backlinks", "", path.clone());
    snapshot.command(
        "index_backlink_page",
        "the first page",
        json!({ "path": "notes/car.md", "limit": 5, "cursor": null }),
    );
    snapshot.command(
        "index_backlink_page",
        "after a cursor",
        json!({
            "path": "notes/car.md",
            "limit": 5,
            "cursor": { "recencyMs": 100, "sourcePath": "notes/a.md" },
        }),
    );
    snapshot.command(
        "index_suggest_tags",
        "every tag",
        json!({ "tagKey": "", "limit": 5 }),
    );
    snapshot.command(
        "index_suggest_tags",
        "a tag key",
        json!({ "tagKey": "a", "limit": 5 }),
    );
    snapshot.command("index_wiki_candidates", "no key", json!({ "key": "" }));
    snapshot.command("index_wiki_candidates", "a key", json!({ "key": "car" }));
    snapshot.command(
        "index_wiki_candidates",
        "a key with no search term",
        json!({ "key": "%" }),
    );
    snapshot.command("index_wiki_key_winners", "", json!({ "keys": ["car"] }));
    snapshot.command("index_wiki_winning_aliases", "", json!({ "paths": paths }));

    snapshot.command("embed_chunk_hashes", "", path);
    snapshot.command(
        "embed_related_chunks",
        "",
        json!({ "path": "notes/car.md", "seedLimit": 2, "candidates": 5 }),
    );
    snapshot.command(
        "embed_semantic_chunks",
        "",
        json!({ "vector": vec![0.1_f32; 384], "candidates": 5 }),
    );

    snapshot.command("index_search", "no text, no filter", search(json!({})));
    snapshot.command(
        "index_search",
        "no text, pins first",
        search(json!({ "pinnedFirst": true, "limit": 20 })),
    );
    snapshot.command(
        "index_search",
        "no text, daily notes",
        search(json!({ "dailyOnly": true })),
    );
    snapshot.command(
        "index_search",
        "no text, every filter",
        search(filtered_search("")),
    );
    snapshot.command(
        "index_search",
        "text",
        search(json!({ "text": "car trip", "titleKey": "car trip" })),
    );
    snapshot.command(
        "index_search",
        "text, every filter",
        search(filtered_search("car trip")),
    );

    snapshot.command("chat_conversations", "", json!({ "limit": 5 }));
    snapshot.command("chat_messages", "", json!({ "conversationId": "c1" }));

    // The reads that have no command.
    let ranked = SearchRequest {
        text: "car".to_string(),
        title_key: "car".to_string(),
        ..SearchRequest::default()
    };
    let options = RankedOptions {
        exclude_private: true,
        snippet_tokens: 10,
    };
    snapshot
        .session
        .read(snapshot.generation, |conn| {
            search_ranked(conn, &ranked, options)
        })
        .unwrap();
    snapshot.section("search_ranked: without private notes");
    let files = [FileMeta {
        path: "notes/car.md".to_string(),
        size: 1,
        modified_ms: 1,
        placeholder: false,
    }];
    snapshot
        .session
        .reconcile_scan(snapshot.generation, &files, 0)
        .unwrap();
    snapshot.section("reconcile_scan");
}

#[test]
fn every_statement_matches_the_snapshot() {
    let mut snapshot = Snapshot::new();
    write_cases(&mut snapshot);

    let all: BTreeSet<String> = INDEX_WRITE_COMMANDS
        .iter()
        .chain(INDEX_READ_COMMANDS)
        .map(|command| command.to_string())
        .collect();
    assert_eq!(snapshot.commands, all, "each command has a case");

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/statements.sql");
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(path, &snapshot.text).unwrap();
        return;
    }
    let changed = snapshot
        .text
        .lines()
        .zip(SNAPSHOT.lines())
        .position(|(now, before)| now != before)
        .unwrap_or_else(|| snapshot.text.lines().count().min(SNAPSHOT.lines().count()));
    assert!(
        snapshot.text == SNAPSHOT,
        "the statements differ from {path} at line {}:\n  snapshot: {}\n  now:      {}\n\
         Run `UPDATE_SNAPSHOTS=1 cargo test -p reflect-index statements` and review the diff.",
        changed + 1,
        SNAPSHOT.lines().nth(changed).unwrap_or("<end>"),
        snapshot.text.lines().nth(changed).unwrap_or("<end>"),
    );
}

#[test]
fn layout_breaks_at_clauses_outside_strings() {
    assert_eq!(
        layout("SELECT a FROM t WHERE b IN (SELECT c FROM u WHERE d = ' FROM x') AND e LIMIT ?"),
        "SELECT a\n  FROM t\n  WHERE b IN (SELECT c\n    FROM u\n    WHERE d = ' FROM x')\n  AND e\n  LIMIT ?",
    );
    assert_eq!(
        layout("DELETE FROM t WHERE a = ?"),
        "DELETE FROM t\n  WHERE a = ?"
    );
}
