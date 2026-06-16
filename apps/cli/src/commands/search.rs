//! `reflect search <query>` — ranked lexical search over the FTS index. The
//! one command that requires the index: missing/unusable is exit 4 (the CLI
//! never builds or repairs the index — that's the desktop app's job). A stale
//! index warns and still returns rows.

use std::fs;
use std::path::Path;

use reflect_index_schema::{INDEX_FILE, REFLECT_DIR};

use crate::commands::output::{print_json, HitJson, SearchJson};
use crate::commands::warn;
use crate::error::CliError;
use crate::graph::Graph;
use crate::index::{detect_staleness, open_read_only, IndexOpen};
use crate::keys::fold_key;
use crate::note_file::parse_note_meta;
use crate::search::{build_fts_match, search_index, SearchHit};

/// The privacy re-check: the index row said public, but the file's own
/// frontmatter is the truth — a note flagged private after the last index run
/// must not surface. A missing file keeps its hit (the index briefly lags
/// deletes; path + indexed title leak no content a delete was protecting).
fn still_public_on_disk(root: &Path, rel_path: &str) -> bool {
    match fs::read_to_string(root.join(rel_path)) {
        Ok(content) => !parse_note_meta(rel_path, &content).private,
        Err(_) => true,
    }
}

pub fn run(graph: &Graph, json: bool, query: &str, limit: usize) -> Result<(), CliError> {
    let opened = match open_read_only(&graph.root) {
        IndexOpen::Opened(opened) => opened,
        IndexOpen::Missing => {
            return Err(CliError::NoIndex(format!(
                "no search index at {REFLECT_DIR}/{INDEX_FILE} — open this graph in Reflect to build it"
            )))
        }
        IndexOpen::Unusable(message) => return Err(CliError::NoIndex(message)),
    };
    if opened.newer_schema {
        warn("the index schema is newer than this CLI — update Reflect");
    }

    let staleness = detect_staleness(&opened.conn, &graph.root)?;
    if staleness.is_stale() {
        warn(format!(
            "the index may be stale ({} file(s) differ from it) — open the graph in Reflect to refresh",
            staleness.total()
        ));
    }

    let hits: Vec<SearchHit> = match build_fts_match(query) {
        Some(match_expr) => search_index(&opened.conn, &match_expr, &fold_key(query), limit)?,
        None => Vec::new(),
    };
    let hits: Vec<SearchHit> = hits
        .into_iter()
        .filter(|hit| still_public_on_disk(&graph.root, &hit.path))
        .collect();

    if json {
        return print_json(&SearchJson {
            query,
            stale: staleness.is_stale(),
            results: hits
                .into_iter()
                .map(|hit| HitJson {
                    path: hit.path,
                    title: hit.title,
                    snippet: hit.snippet,
                    score: hit.score,
                })
                .collect(),
        });
    }
    for hit in &hits {
        println!("{}\t{}", hit.path, hit.title);
        if !hit.snippet.is_empty() {
            println!("    {}", hit.snippet.replace('\n', " "));
        }
    }
    Ok(())
}
