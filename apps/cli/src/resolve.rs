//! `<note>` argument resolution for `show`/`path`. The order mirrors
//! `resolveWikiLink` (`packages/core/src/markdown/resolve.ts`) with a path
//! convenience first-class for a CLI: calendar-valid `YYYY-MM-DD` → explicit
//! graph path → title fold-key → alias fold-key. Index-backed when the index
//! is open; otherwise a file scan derives the same titles/aliases.

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection};

use crate::error::CliError;
use crate::keys::fold_key;
use crate::note_file::{checked_note_path, parse_note_meta, walk_notes};
use crate::paths::{daily_path, parse_calendar_date};

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
/// inside the graph). Only existing eligible Markdown files qualify; anything
/// else falls through to title/alias matching. Symlinked path components are
/// refused even when their target happens to remain inside the graph.
fn as_graph_path(arg: &str, root: &Path) -> Option<String> {
    let candidate = Path::new(arg);
    let canonical_root = root.canonicalize().ok()?;
    let relative = if candidate.is_absolute() {
        absolute_graph_relative(candidate, &canonical_root)?
    } else {
        candidate.to_path_buf()
    };
    let rel_path = relative.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
    // User-typed arguments deserve shell-style tolerance (`./notes/a.md`,
    // `notes//a.md`); the wire form stays strict, so normalize before the
    // classifier sees it.
    let rel_path = rel_path
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>()
        .join("/");
    let current = checked_note_path(&canonical_root, &rel_path).ok()?;
    if !current.is_file() || !current.canonicalize().ok()?.starts_with(&canonical_root) {
        return None;
    }
    Some(rel_path)
}

/// Find the lexical graph boundary for an absolute path by canonicalizing its
/// ancestors. This accepts aliases of the graph root (for example macOS's
/// `/var` → `/private/var`) without canonicalizing away symlinks below it;
/// [`checked_note_path`] still inspects every component of the returned suffix.
fn absolute_graph_relative(candidate: &Path, canonical_root: &Path) -> Option<PathBuf> {
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    candidate.ancestors().find_map(|ancestor| {
        if ancestor.canonicalize().ok()?.as_path() != canonical_root {
            return None;
        }
        candidate.strip_prefix(ancestor).ok().map(Path::to_path_buf)
    })
}

/// Title matches first, alias matches only when no title matched — the
/// `byTitle ?? byAlias` precedence — each tier ordered by path so collisions
/// resolve deterministically (same rule as the desktop's `resolveWikiTarget`).
fn index_lookup(conn: &Connection, key: &str) -> Result<Vec<String>, CliError> {
    // Templates never resolve by title/alias (the desktop rule) — only an
    // explicit `templates/...` path argument reaches one.
    let by_title = collect_paths(
        conn,
        "SELECT path FROM notes WHERE title_key = ?1 AND kind != 'template' ORDER BY path",
        key,
    )?;
    if !by_title.is_empty() {
        return Ok(by_title);
    }
    collect_paths(
        conn,
        "SELECT note_path FROM aliases
         JOIN notes ON notes.path = aliases.note_path AND notes.kind != 'template'
         WHERE alias_key = ?1 ORDER BY note_path",
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
    for note in walk_notes(root) {
        if note.rel_path.starts_with("templates/") {
            continue; // templates never resolve by title/alias
        }
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

#[cfg(test)]
mod tests {
    use super::as_graph_path;

    #[test]
    fn explicit_paths_accept_root_and_nested_notes_only() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("README.md"), "root").expect("write");
        std::fs::create_dir_all(temp.path().join("Projects/.hidden")).expect("mkdir");
        std::fs::write(temp.path().join("Projects/plan.md"), "plan").expect("write");
        std::fs::write(temp.path().join("Projects/.hidden/secret.md"), "secret").expect("write");
        std::fs::create_dir_all(temp.path().join("assets")).expect("mkdir");
        std::fs::write(temp.path().join("assets/caption.md"), "caption").expect("write");
        let root = temp.path().canonicalize().expect("canonical root");

        assert_eq!(
            as_graph_path("README.md", &root).as_deref(),
            Some("README.md")
        );
        assert_eq!(
            as_graph_path("Projects/plan.md", &root).as_deref(),
            Some("Projects/plan.md")
        );
        assert_eq!(as_graph_path("Projects/.hidden/secret.md", &root), None);
        assert_eq!(as_graph_path("assets/caption.md", &root), None);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_paths_refuse_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("real.md"), "real").expect("write");
        symlink(temp.path().join("real.md"), temp.path().join("linked.md")).expect("symlink");
        let root = temp.path().canonicalize().expect("canonical root");

        assert_eq!(as_graph_path("linked.md", &root), None);
    }

    #[cfg(unix)]
    #[test]
    fn absolute_paths_accept_different_aliases_of_the_graph_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let real_root = temp.path().join("real-vault");
        let alias_root = temp.path().join("vault-alias");
        std::fs::create_dir(&real_root).expect("mkdir");
        std::fs::write(real_root.join("README.md"), "root").expect("write");
        symlink(&real_root, &alias_root).expect("symlink");

        assert_eq!(
            as_graph_path(
                real_root.join("README.md").to_str().expect("UTF-8 path"),
                &alias_root,
            )
            .as_deref(),
            Some("README.md")
        );
        assert_eq!(
            as_graph_path(
                alias_root.join("README.md").to_str().expect("UTF-8 path"),
                &real_root,
            )
            .as_deref(),
            Some("README.md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn absolute_paths_still_refuse_symlinks_below_the_graph_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(temp.path().join("Projects")).expect("mkdir");
        std::fs::write(temp.path().join("Projects/plan.md"), "plan").expect("write");
        symlink(
            temp.path().join("Projects"),
            temp.path().join("linked-projects"),
        )
        .expect("symlink");

        assert_eq!(
            as_graph_path(
                temp.path()
                    .join("linked-projects/plan.md")
                    .to_str()
                    .expect("UTF-8 path"),
                temp.path(),
            ),
            None
        );
    }
}
