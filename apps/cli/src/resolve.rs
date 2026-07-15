//! `<note>` argument resolution for `show`/`path`. The order mirrors
//! `resolveWikiLink` (`packages/core/src/markdown/resolve.ts`) with a path
//! convenience first-class for a CLI: calendar-valid `YYYY-MM-DD` → explicit
//! graph path → authored-title fold-key → alias fold-key → filename stem.
//! Resolution always walks the live vault: the read-only index remains useful
//! for search, but cannot authoritatively answer after external file changes.

use std::path::{Component, Path, PathBuf};

use crate::error::CliError;
use crate::keys::fold_key;
use crate::note_file::{basename, checked_note_path, parse_note_meta, walk_notes};
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

/// Derive every note's title/aliases from the current files and match the
/// desktop's ranked tiers. `walk_notes` returns sorted paths, so ambiguous
/// matches retain the CLI's deterministic-first-path behavior. An unavailable
/// candidate fails the whole lookup closed because its live keys are unknown.
/// Private and privacy-uncertain notes are excluded before any tier is built,
/// so they neither win nor suppress a lower-ranked public match.
fn scan_lookup(root: &Path, key: &str) -> Result<Vec<String>, CliError> {
    let mut by_title = Vec::new();
    let mut by_alias = Vec::new();
    let mut by_basename = Vec::new();
    for note in walk_notes(root)? {
        if note.rel_path.starts_with("templates/") {
            continue; // templates never resolve by title/alias
        }
        if note.placeholder {
            return Err(CliError::Runtime(
                "cannot safely resolve notes while an unavailable note is waiting for iCloud download"
                    .to_string(),
            ));
        }
        let content = std::fs::read_to_string(root.join(&note.rel_path)).map_err(|_| {
            CliError::Runtime(
                "cannot safely resolve notes because a note could not be read".to_string(),
            )
        })?;
        let meta = parse_note_meta(&note.rel_path, &content);
        if meta.private || meta.privacy_uncertain {
            continue;
        }
        if meta.authored_title && fold_key(&meta.title) == key {
            by_title.push(note.rel_path);
            continue;
        }
        if meta.aliases.iter().any(|alias| fold_key(alias) == key) {
            by_alias.push(note.rel_path);
            continue;
        }
        if fold_key(basename(&note.rel_path)) == key {
            by_basename.push(note.rel_path);
        }
    }
    Ok(if !by_title.is_empty() {
        by_title
    } else if !by_alias.is_empty() {
        by_alias
    } else {
        by_basename
    })
}

/// Resolve a `<note>` argument. Ambiguous matches resolve to the first path
/// (deterministic) and note the others on stderr.
pub fn resolve_note(arg: &str, root: &Path) -> Result<ResolvedNote, CliError> {
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
    let matches = scan_lookup(root, &key)?;
    match matches.split_first() {
        None => Err(CliError::NotFound(format!(
            "no note matching '{trimmed}' (by date, path, title, alias, or filename)"
        ))),
        Some((first, rest)) => {
            if !rest.is_empty() {
                eprintln!(
                    "reflect: note: {} other match(es) for '{trimmed}'; using the first deterministic match",
                    rest.len()
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
    use super::{as_graph_path, scan_lookup};

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

    #[test]
    fn scan_lookup_ranks_aliases_above_filename_stems() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Projects")).expect("mkdir");
        std::fs::create_dir_all(temp.path().join("notes")).expect("mkdir");
        std::fs::write(temp.path().join("Projects/Target.md"), "No authored title").expect("write");
        std::fs::write(
            temp.path().join("notes/alias.md"),
            "---\naliases: [Target]\n---\n# Other",
        )
        .expect("write");

        assert_eq!(
            scan_lookup(temp.path(), "target").expect("lookup"),
            vec!["notes/alias.md"]
        );
    }

    #[test]
    fn scan_lookup_excludes_private_and_privacy_uncertain_matches() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("A-Private")).expect("mkdir");
        std::fs::create_dir_all(temp.path().join("B-Uncertain")).expect("mkdir");
        std::fs::create_dir_all(temp.path().join("Z-Public")).expect("mkdir");
        std::fs::write(
            temp.path().join("A-Private/plan.md"),
            "---\nprivate: true\n---\n# Plan\n",
        )
        .expect("private note");
        std::fs::write(
            temp.path().join("B-Uncertain/plan.md"),
            "---\nprivate: [broken\n---\n# Plan\n",
        )
        .expect("uncertain note");
        std::fs::write(temp.path().join("Z-Public/plan.md"), "# Plan\n").expect("public note");
        std::fs::write(
            temp.path().join("A-Private/secret-alias.md"),
            "---\nprivate: true\naliases: [Shortcut]\n---\n# Hidden\n",
        )
        .expect("private alias");
        std::fs::write(
            temp.path().join("Z-Public/public-alias.md"),
            "---\naliases: [Shortcut]\n---\n# Visible\n",
        )
        .expect("public alias");
        std::fs::write(
            temp.path().join("A-Private/Target.md"),
            "---\nprivate: true\n---\nno authored title\n",
        )
        .expect("private basename");
        std::fs::write(
            temp.path().join("Z-Public/Target.md"),
            "no authored title\n",
        )
        .expect("public basename");

        assert_eq!(
            scan_lookup(temp.path(), "plan").expect("lookup"),
            vec!["Z-Public/plan.md"]
        );
        assert_eq!(
            scan_lookup(temp.path(), "shortcut").expect("lookup"),
            vec!["Z-Public/public-alias.md"]
        );
        assert_eq!(
            scan_lookup(temp.path(), "target").expect("lookup"),
            vec!["Z-Public/Target.md"]
        );
    }

    #[test]
    fn scan_lookup_fails_closed_for_an_icloud_placeholder() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Sensitive-Client")).expect("mkdir");
        std::fs::write(
            temp.path()
                .join("Sensitive-Client/.Unannounced-Merger.md.icloud"),
            "placeholder",
        )
        .expect("write");

        let error = scan_lookup(temp.path(), "plan").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("unavailable"));
        assert!(!message.contains("Sensitive-Client"));
        assert!(!message.contains("Unannounced-Merger"));
    }

    #[test]
    fn scan_lookup_fails_closed_for_unreadable_markdown() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Sensitive-Client")).expect("mkdir");
        std::fs::write(
            temp.path().join("Sensitive-Client/Stealth-Launch.md"),
            [0xff],
        )
        .expect("write");

        let error = scan_lookup(temp.path(), "plan").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("could not be read"));
        assert!(!message.contains("Sensitive-Client"));
        assert!(!message.contains("Stealth-Launch"));
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
