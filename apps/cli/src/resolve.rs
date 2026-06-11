//! `<note>` argument resolution for `show`/`path`. The order mirrors
//! `resolveWikiLink` (`packages/core/src/markdown/resolve.ts`) with a path
//! convenience first-class for a CLI: calendar-valid `YYYY-MM-DD` → explicit
//! graph path → title fold-key → alias fold-key. Index-backed when the index
//! is open; otherwise a file scan derives the same titles/aliases.

use std::path::Path;

use rusqlite::{params, Connection};

use crate::error::CliError;
use crate::keys::fold_key;
use crate::note_file::{parse_note_meta, walk_notes};
use crate::paths::{daily_path, parse_calendar_date, NOTE_DIRS};

/// What a `<note>` argument resolved to.
pub enum ResolvedNote {
    /// A daily reference; the file may not exist yet (dailies are lazy).
    Daily { date: String, rel_path: String },
    /// An existing note file.
    File { rel_path: String },
}

impl ResolvedNote {
    pub fn rel_path(&self) -> &str {
        match self {
            ResolvedNote::Daily { rel_path, .. } | ResolvedNote::File { rel_path } => rel_path,
        }
    }
}

/// Interpret `arg` as an explicit note path (graph-relative, or absolute
/// inside the graph). Only existing `.md` files under `daily/`/`notes/`
/// qualify; anything else falls through to title/alias matching.
fn as_graph_path(arg: &str, root: &Path) -> Option<String> {
    let candidate = Path::new(arg);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical = absolute.canonicalize().ok()?;
    if !canonical.is_file() {
        return None;
    }
    let rel = canonical.strip_prefix(root).ok()?;
    let rel_path = rel.to_string_lossy().replace('\\', "/");
    let under_note_dir = NOTE_DIRS
        .iter()
        .any(|dir| rel_path.starts_with(&format!("{dir}/")));
    (under_note_dir && rel_path.ends_with(".md")).then_some(rel_path)
}

/// Title matches first, alias matches only when no title matched — the
/// `byTitle ?? byAlias` precedence — each tier ordered by path so collisions
/// resolve deterministically (same rule as the desktop's `resolveWikiTarget`).
fn index_lookup(conn: &Connection, key: &str) -> Result<Vec<String>, CliError> {
    let by_title = collect_paths(
        conn,
        "SELECT path FROM notes WHERE title_key = ?1 ORDER BY path",
        key,
    )?;
    if !by_title.is_empty() {
        return Ok(by_title);
    }
    collect_paths(
        conn,
        "SELECT note_path FROM aliases WHERE alias_key = ?1 ORDER BY note_path",
        key,
    )
}

fn collect_paths(conn: &Connection, sql: &str, key: &str) -> Result<Vec<String>, CliError> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params![key], |row| row.get::<_, String>(0))?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    Ok(paths)
}

/// The index-free fallback: derive every note's title/aliases from disk and
/// match the same fold keys (`walk_notes` returns paths sorted, so the
/// deterministic-first-match rule holds here too).
fn scan_lookup(root: &Path, key: &str) -> Result<Vec<String>, CliError> {
    let mut by_title = Vec::new();
    let mut by_alias = Vec::new();
    for note in walk_notes(root)? {
        let Ok(content) = std::fs::read_to_string(root.join(&note.rel_path)) else {
            continue;
        };
        let meta = parse_note_meta(&note.rel_path, &content);
        if fold_key(&meta.title) == key {
            by_title.push(note.rel_path);
        } else if meta.aliases.iter().any(|alias| fold_key(alias) == key) {
            by_alias.push(note.rel_path);
        }
    }
    Ok(if by_title.is_empty() {
        by_alias
    } else {
        by_title
    })
}

/// Resolve a `<note>` argument. Ambiguous matches resolve to the first path
/// (deterministic) and note the others on stderr.
pub fn resolve_note(
    arg: &str,
    root: &Path,
    conn: Option<&Connection>,
) -> Result<ResolvedNote, CliError> {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return Err(CliError::NotFound("empty note reference".to_string()));
    }
    if let Some(date) = parse_calendar_date(trimmed) {
        return Ok(ResolvedNote::Daily {
            date: date.to_string(),
            rel_path: daily_path(date),
        });
    }
    if let Some(rel_path) = as_graph_path(trimmed, root) {
        return Ok(ResolvedNote::File { rel_path });
    }
    let key = fold_key(trimmed);
    let matches = match conn {
        Some(conn) => index_lookup(conn, &key)?,
        None => scan_lookup(root, &key)?,
    };
    match matches.split_first() {
        None => Err(CliError::NotFound(format!(
            "no note matching '{trimmed}' (by date, path, title, or alias)"
        ))),
        Some((first, rest)) => {
            if !rest.is_empty() {
                eprintln!(
                    "reflect: note: {} other match(es) for '{trimmed}': {}",
                    rest.len(),
                    rest.join(", ")
                );
            }
            Ok(ResolvedNote::File {
                rel_path: first.clone(),
            })
        }
    }
}
