//! The file read layer: note metadata straight from disk, no index required.
//! Title derivation mirrors `deriveTitle` in
//! `packages/core/src/markdown/extract.ts`; the walk mirrors the desktop's
//! `collect_markdown` (`apps/desktop/src-tauri/src/fs/io.rs`).

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag};

use crate::error::CliError;
use crate::frontmatter::{parse_frontmatter, split_frontmatter, Frontmatter};
use crate::paths::{date_from_daily_path, NOTE_DIRS};

/// A note's derived metadata, as the TS indexer would compute it.
#[derive(Debug)]
pub struct NoteMeta {
    pub title: String,
    pub aliases: Vec<String>,
    pub private: bool,
}

/// A note read off disk: full source plus derived metadata.
pub struct Note {
    pub content: String,
    pub meta: NoteMeta,
}

/// One markdown file found by [`walk_notes`].
pub struct DiskNote {
    /// Graph-relative, forward-slashed.
    pub rel_path: String,
    /// Last-modified time in epoch milliseconds (the `notes.mtime` unit).
    pub mtime_ms: u64,
}

/// Filename without directories or the `.md` extension (the TS `basename`).
fn basename(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    if file.len() >= 3 && file[file.len() - 3..].eq_ignore_ascii_case(".md") {
        &file[..file.len() - 3]
    } else {
        file
    }
}

/// The TS `cleanHeadingText`: setext headings keep their first line; ATX
/// headings lose the leading hashes and any trailing closing hashes.
fn clean_heading_text(raw: &str) -> String {
    let raw = raw
        .strip_suffix('\n')
        .map(|text| text.strip_suffix('\r').unwrap_or(text))
        .unwrap_or(raw);
    if let Some(newline_at) = raw.find('\n') {
        return raw[..newline_at].trim().to_string();
    }
    let text = raw.trim_start();
    let text = text.trim_start_matches('#');
    let text = text.trim_start_matches([' ', '\t']);
    let text = text.trim_end_matches([' ', '\t']);
    let text = text.trim_end_matches('#');
    text.trim().to_string()
}

/// First level-1 heading with non-empty text, cleaned like the TS extractor
/// (raw source slice, so inline markup is kept verbatim). pulldown-cmark gives
/// CommonMark semantics — a `# line` inside a code fence is not a heading.
fn first_h1(body: &str) -> Option<String> {
    for (event, range) in Parser::new(body).into_offset_iter() {
        if let Event::Start(Tag::Heading {
            level: HeadingLevel::H1,
            ..
        }) = event
        {
            let text = clean_heading_text(&body[range]);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// The TS `deriveTitle` chain: frontmatter `title` → first H1 → daily date →
/// filename.
fn derive_title(rel_path: &str, frontmatter: &Frontmatter, body: &str) -> String {
    if let Some(title) = frontmatter.title.as_deref() {
        let title = title.trim();
        if !title.is_empty() {
            return title.to_string();
        }
    }
    if let Some(heading) = first_h1(body) {
        return heading;
    }
    if let Some(date) = date_from_daily_path(rel_path) {
        return date.to_string();
    }
    basename(rel_path).to_string()
}

/// Derive a note's metadata from its source, as the TS indexer would.
pub fn parse_note_meta(rel_path: &str, source: &str) -> NoteMeta {
    let split = split_frontmatter(source);
    let frontmatter = parse_frontmatter(split.raw);
    let title = derive_title(rel_path, &frontmatter, split.body);
    NoteMeta {
        title,
        aliases: frontmatter.aliases,
        private: frontmatter.private,
    }
}

/// Read a note and enforce the privacy contract: a `private: true` note is
/// refused (exit 3), based on the file's own frontmatter — never an index row.
pub fn read_note(root: &Path, rel_path: &str) -> Result<Note, CliError> {
    let absolute = root.join(rel_path);
    let content = fs::read_to_string(&absolute)
        .map_err(|err| CliError::Runtime(format!("could not read {rel_path}: {err}")))?;
    let meta = parse_note_meta(rel_path, &content);
    if meta.private {
        return Err(CliError::Private(format!("note is private: {rel_path}")));
    }
    Ok(Note { content, meta })
}

/// Enforce the privacy contract without returning content (used by `path`).
/// A missing file has nothing to protect.
pub fn ensure_not_private(root: &Path, rel_path: &str) -> Result<(), CliError> {
    let Ok(content) = fs::read_to_string(root.join(rel_path)) else {
        return Ok(());
    };
    if parse_note_meta(rel_path, &content).private {
        return Err(CliError::Private(format!("note is private: {rel_path}")));
    }
    Ok(())
}

/// Every `.md` under `daily/` + `notes/`, recursively — same contract as the
/// desktop's `collect_markdown`: symlinks are skipped, paths come back
/// graph-relative and forward-slashed.
pub fn walk_notes(root: &Path) -> Result<Vec<DiskNote>, CliError> {
    let mut notes = Vec::new();
    for dir in NOTE_DIRS {
        let base = root.join(dir);
        if !base.is_dir() {
            continue;
        }
        let mut stack = vec![base];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current)? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !file_type.is_file()
                    || path.extension().and_then(|ext| ext.to_str()) != Some("md")
                {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(root) else {
                    continue;
                };
                let mtime_ms = entry
                    .metadata()?
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                notes.push(DiskNote {
                    rel_path: rel.to_string_lossy().replace('\\', "/"),
                    mtime_ms,
                });
            }
        }
    }
    notes.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parity with `deriveTitle` (`extract.ts`): frontmatter `title` → first
    /// H1 → daily date → filename, with the same cleaning rules.
    #[test]
    fn title_chain_matches_the_ts_extractor() {
        let meta = parse_note_meta("notes/a.md", "---\ntitle: FM Title\n---\n# H1\n");
        assert_eq!(meta.title, "FM Title");

        let meta = parse_note_meta("notes/a.md", "intro\n\n# The *Heading* [[Link]]\n");
        assert_eq!(meta.title, "The *Heading* [[Link]]");

        let meta = parse_note_meta("notes/a.md", "Setext Title\n===\nbody\n");
        assert_eq!(meta.title, "Setext Title");

        let meta = parse_note_meta("notes/a.md", "## only an h2\n");
        assert_eq!(meta.title, "a");

        let meta = parse_note_meta("daily/2026-06-11.md", "plain text\n");
        assert_eq!(meta.title, "2026-06-11");

        let meta = parse_note_meta("notes/Fancy Name.md", "no headings\n");
        assert_eq!(meta.title, "Fancy Name");
    }

    #[test]
    fn h1_inside_a_code_fence_is_not_a_title() {
        let meta = parse_note_meta("notes/a.md", "```\n# not a heading\n```\n");
        assert_eq!(meta.title, "a");
    }

    #[test]
    fn closing_hashes_and_whitespace_are_stripped() {
        let meta = parse_note_meta("notes/a.md", "#   Spaced Out  ##\n");
        assert_eq!(meta.title, "Spaced Out");
    }

    #[test]
    fn empty_h1_is_skipped_for_a_later_one() {
        let meta = parse_note_meta("notes/a.md", "#\n\n# Real Title\n");
        assert_eq!(meta.title, "Real Title");
    }
}
