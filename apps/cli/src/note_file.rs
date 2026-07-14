//! The file read layer: note metadata straight from disk, no index required.
//! Title derivation mirrors `deriveTitle` in
//! `packages/core/src/markdown/extract.ts`; the walk mirrors the desktop's
//! `collect_markdown` (`apps/desktop/src-tauri/src/fs/io.rs`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag};
use reflect_graph_paths::{evicted_logical_path, eviction_placeholder};

use crate::error::CliError;
use crate::frontmatter::{parse_frontmatter, split_frontmatter, Frontmatter};
use crate::keys::fold_key;
use crate::paths::date_from_daily_path;

/// A note's derived metadata, as the TS indexer would compute it.
#[derive(Debug)]
pub struct NoteMeta {
    /// The frontmatter `id` (Plan 17's ULID), when the note carries one.
    pub id: Option<String>,
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
    /// The path exists only as an iCloud eviction placeholder, so its content
    /// is unavailable on this device.
    pub placeholder: bool,
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

/// Split positions of v1 subject-alias separators: exactly two slashes, not
/// preceded by `:` or `/` and not followed by `/`, so URL schemes
/// (`https://…`) and slash runs never split. Mirrors the TS
/// `SUBJECT_ALIAS_SEPARATOR` regex (`subject-aliases.ts`); the bytes checked
/// are ASCII, so the indices are always UTF-8 char boundaries.
fn split_subject_segments(title: &str) -> Vec<&str> {
    let bytes = title.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index + 1 < bytes.len() {
        let separator = bytes[index] == b'/'
            && bytes[index + 1] == b'/'
            && (index == 0 || (bytes[index - 1] != b':' && bytes[index - 1] != b'/'))
            && bytes.get(index + 2) != Some(&b'/');
        if separator {
            segments.push(&title[start..index]);
            start = index + 2;
            index += 2;
        } else {
            index += 1;
        }
    }
    segments.push(&title[start..]);
    segments
}

/// The TS `subjectAliases` (`subject-aliases.ts`): Reflect V1's `//` title
/// convention (`Charlotte MacCaw // Mum`) derived as aliases — each segment
/// trimmed, empties dropped, deduplicated by fold key, first segment included.
fn subject_aliases(title: &str) -> Vec<String> {
    let segments = split_subject_segments(title);
    if segments.len() < 2 {
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    let mut aliases = Vec::new();
    for segment in segments {
        let alias = segment.trim();
        if alias.is_empty() || !seen.insert(fold_key(alias)) {
            continue;
        }
        aliases.push(alias.to_string());
    }
    aliases
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

/// Derive a note's metadata from its source, as the TS indexer would:
/// `aliases:` frontmatter verbatim, then the v1 subject aliases derived from
/// the title, skipping segments a frontmatter alias already claims (the TS
/// `noteAliases`, `indexed-note.ts`).
pub fn parse_note_meta(rel_path: &str, source: &str) -> NoteMeta {
    let split = split_frontmatter(source);
    let frontmatter = parse_frontmatter(split.raw);
    let title = derive_title(rel_path, &frontmatter, split.body);
    let mut aliases = frontmatter.aliases;
    let mut claimed: std::collections::HashSet<String> =
        aliases.iter().map(|alias| fold_key(alias)).collect();
    for alias in subject_aliases(&title) {
        if claimed.insert(fold_key(&alias)) {
            aliases.push(alias);
        }
    }
    NoteMeta {
        id: frontmatter.id,
        title,
        aliases,
        private: frontmatter.private,
    }
}

/// Read a note and enforce the privacy contract: a `private: true` note is
/// refused (exit 3), based on the file's own frontmatter — never an index row.
pub fn read_note(root: &Path, rel_path: &str) -> Result<Note, CliError> {
    let absolute = checked_note_path(root, rel_path)?;
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
    let absolute = checked_note_path(root, rel_path)?;
    let content = match fs::read_to_string(&absolute) {
        Ok(content) => content,
        Err(_) if eviction_placeholder(&absolute).is_some_and(|path| path.is_file()) => {
            return Err(CliError::Runtime(format!(
                "note is unavailable until iCloud downloads it: {rel_path}"
            )))
        }
        Err(_) => return Ok(()),
    };
    if parse_note_meta(rel_path, &content).private {
        return Err(CliError::Private(format!("note is private: {rel_path}")));
    }
    Ok(())
}

/// Resolve one canonical graph-relative note path without following symlinks.
/// The file itself may be absent (daily `path` output relies on that), but any
/// component that exists must be an ordinary in-graph entry.
pub(crate) fn checked_note_path(root: &Path, rel_path: &str) -> Result<PathBuf, CliError> {
    if reflect_graph_paths::classify_normalized(rel_path)
        != Some(reflect_graph_paths::GraphPathKind::Note)
    {
        return Err(CliError::Runtime(format!(
            "unsafe or ineligible note path: {rel_path}"
        )));
    }
    let mut absolute = root.to_path_buf();
    for component in Path::new(rel_path).components() {
        absolute.push(component.as_os_str());
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CliError::Runtime(format!(
                    "refusing symlinked note path: {rel_path}"
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CliError::Runtime(format!(
                    "could not inspect {rel_path}: {error}"
                )))
            }
        }
    }
    Ok(absolute)
}

/// Every eligible `.md` in the graph, recursively — same contract as the
/// desktop listing: hidden/reserved trees are pruned, symlinks are skipped,
/// and paths come back graph-relative and forward-slashed.
pub fn walk_notes(root: &Path) -> Result<Vec<DiskNote>, CliError> {
    let mut notes = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            if file_type.is_dir() {
                if reflect_graph_paths::may_contain_notes(rel) {
                    stack.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let listed = match evicted_logical_path(&path) {
                Some(logical)
                    if logical
                        .strip_prefix(root)
                        .is_ok_and(reflect_graph_paths::is_note)
                        && !logical.exists() =>
                {
                    Some((logical, true))
                }
                Some(_) => None,
                None if reflect_graph_paths::is_note(rel) => Some((path, false)),
                None => None,
            };
            let Some((listed_path, placeholder)) = listed else {
                continue;
            };
            let Ok(listed_rel) = listed_path.strip_prefix(root) else {
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
                rel_path: listed_rel.to_string_lossy().replace('\\', "/"),
                mtime_ms,
                placeholder,
            });
        }
    }
    notes.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_finds_arbitrary_notes_and_prunes_ignored_trees() {
        let root = tempfile::tempdir().expect("tempdir");
        for (path, content) in [
            ("README.md", "root"),
            ("Projects/deep/plan.md", "nested"),
            ("daily/2026-07-14.md", "daily"),
            ("templates/meeting.md", "template"),
            ("assets/caption.md", "reserved"),
            ("audio-memos/transcript.md", "reserved"),
            (".obsidian/plugin.md", "hidden"),
            ("Projects/.private/secret.md", "hidden"),
            ("Projects/upper.MD", "upper"),
        ] {
            let absolute = root.path().join(path);
            fs::create_dir_all(absolute.parent().expect("parent")).expect("mkdir");
            fs::write(absolute, content).expect("write");
        }

        let paths: Vec<String> = walk_notes(root.path())
            .expect("walk")
            .into_iter()
            .map(|note| note.rel_path)
            .collect();
        assert_eq!(
            paths,
            vec![
                "Projects/deep/plan.md",
                "README.md",
                "daily/2026-07-14.md",
                "templates/meeting.md",
            ]
        );
    }

    #[test]
    fn walk_keeps_icloud_placeholders_as_unavailable_notes() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(root.path().join("Projects")).expect("mkdir");
        fs::write(root.path().join("Projects/.plan.md.icloud"), "stub").expect("write");

        let notes = walk_notes(root.path()).expect("walk");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].rel_path, "Projects/plan.md");
        assert!(notes[0].placeholder);
        let error = ensure_not_private(root.path(), "Projects/plan.md").unwrap_err();
        assert!(error.to_string().contains("unavailable"));
    }

    #[cfg(unix)]
    #[test]
    fn walk_does_not_follow_file_or_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        fs::write(outside.path().join("outside.md"), "outside").expect("write");
        fs::create_dir_all(root.path().join("Projects")).expect("mkdir");
        symlink(
            outside.path().join("outside.md"),
            root.path().join("linked.md"),
        )
        .expect("file symlink");
        symlink(outside.path(), root.path().join("Projects/linked")).expect("directory symlink");

        assert!(walk_notes(root.path()).expect("walk").is_empty());
    }

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

    /// Parity with `subjectAliases` (`subject-aliases.ts`): v1 `//` titles
    /// derive every trimmed segment, first included, deduplicated by fold key.
    #[test]
    fn subject_aliases_match_the_ts_derivation() {
        assert_eq!(
            subject_aliases("Charlotte MacCaw // Mum"),
            vec!["Charlotte MacCaw", "Mum"]
        );
        assert_eq!(subject_aliases("Charlotte//Mum"), vec!["Charlotte", "Mum"]);
        assert_eq!(
            subject_aliases("Charlotte MacCaw // "),
            vec!["Charlotte MacCaw"]
        );
        assert_eq!(
            subject_aliases("Mum //  // MUM // Mother"),
            vec!["Mum", "Mother"]
        );
        assert_eq!(subject_aliases("Charlotte MacCaw"), Vec::<String>::new());
        assert_eq!(subject_aliases("https://reflect.app"), Vec::<String>::new());
        assert_eq!(subject_aliases("a///b"), Vec::<String>::new());
        assert_eq!(subject_aliases("file:///etc/hosts"), Vec::<String>::new());
        assert_eq!(
            subject_aliases("Reflect // https://reflect.app"),
            vec!["Reflect", "https://reflect.app"]
        );
    }

    /// Parity with `noteAliases` (`indexed-note.ts`): frontmatter aliases stay
    /// verbatim and first; derived segments they already claim are skipped.
    #[test]
    fn subject_aliases_merge_after_frontmatter_aliases() {
        let meta = parse_note_meta(
            "notes/charlotte.md",
            "---\naliases: [MUM]\n---\n# Charlotte MacCaw // Mum\n",
        );
        assert_eq!(meta.aliases, vec!["MUM", "Charlotte MacCaw"]);
    }
}
