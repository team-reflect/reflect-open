//! Derive concise backup commit subjects from staged graph note metadata.

use std::path::Path;

use git2::{Commit, Delta, DiffOptions, Repository, Tree};

use crate::error::AppResult;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChangeAction {
    Add,
    Update,
    Delete,
    Rename,
}

#[derive(Debug, Eq, PartialEq)]
struct TreeChange {
    action: ChangeAction,
    path: String,
    old_path: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
struct NoteChange {
    action: ChangeAction,
    label: String,
    old_label: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
enum AuthoredNoteTitle {
    Public(String),
    Private,
}

/// Return a staged-tree-derived commit subject, falling back when the staged
/// tree is metadata-only or otherwise too noisy to summarize clearly.
pub(super) fn message_for_commit(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    fallback: &str,
) -> AppResult<String> {
    let changes = tree_changes(repo, parent, tree)?;
    Ok(describe_changes(repo, parent, tree, &changes).unwrap_or_else(|| fallback.to_string()))
}

fn tree_changes(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
) -> AppResult<Vec<TreeChange>> {
    let parent_tree = match parent {
        Some(parent) => Some(parent.tree()?),
        None => None,
    };
    let mut options = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(tree), Some(&mut options))?;
    diff.find_similar(None)?;

    let mut changes = Vec::new();
    diff.foreach(
        &mut |delta, _progress| {
            if let Some(change) = tree_change_from_delta(delta.status(), &delta) {
                changes.push(change);
            }
            true
        },
        None,
        None,
        None,
    )?;
    Ok(changes)
}

fn tree_change_from_delta(status: Delta, delta: &git2::DiffDelta<'_>) -> Option<TreeChange> {
    let action = match status {
        Delta::Added | Delta::Copied => ChangeAction::Add,
        Delta::Deleted => ChangeAction::Delete,
        Delta::Renamed => ChangeAction::Rename,
        Delta::Modified | Delta::Typechange => ChangeAction::Update,
        _ => return None,
    };
    let path = match action {
        ChangeAction::Delete => diff_path(delta.old_file().path())?,
        _ => diff_path(delta.new_file().path())?,
    };
    let old_path = (action == ChangeAction::Rename)
        .then(|| diff_path(delta.old_file().path()))
        .flatten();
    Some(TreeChange {
        action,
        path,
        old_path,
    })
}

fn diff_path(path: Option<&Path>) -> Option<String> {
    path.map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn describe_changes(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    changes: &[TreeChange],
) -> Option<String> {
    let content_changes: Vec<&TreeChange> = changes
        .iter()
        .filter(|change| !is_backup_metadata_path(&change.path))
        .collect();
    if content_changes.is_empty() {
        return None;
    }

    let note_changes: Vec<NoteChange> = content_changes
        .iter()
        .filter_map(|change| note_change(repo, parent, tree, change))
        .collect();
    let attachment_changes: Vec<&TreeChange> = content_changes
        .iter()
        .copied()
        .filter(|change| is_attachment_path(&change.path))
        .collect();
    let other_count = content_changes.len() - note_changes.len() - attachment_changes.len();

    if note_changes.len() == content_changes.len() {
        return describe_note_changes(&note_changes);
    }
    if attachment_changes.len() == content_changes.len() {
        return describe_group(&attachment_changes, "attachment", "attachments");
    }
    if !note_changes.is_empty() && other_count == 0 {
        let action = group_action(content_changes.iter().map(|change| change.action));
        return Some(limit_subject(format!(
            "{} {} and {}",
            action.verb(),
            count_phrase(note_changes.len(), "note", "notes"),
            count_phrase(attachment_changes.len(), "attachment", "attachments")
        )));
    }
    if !note_changes.is_empty() {
        let action = group_action(content_changes.iter().map(|change| change.action));
        return Some(limit_subject(format!(
            "{} {} and {}",
            action.verb(),
            count_phrase(note_changes.len(), "note", "notes"),
            count_phrase(content_changes.len() - note_changes.len(), "file", "files")
        )));
    }
    None
}

fn describe_note_changes(changes: &[NoteChange]) -> Option<String> {
    match changes {
        [] => None,
        [change] => Some(limit_subject(match change.action {
            ChangeAction::Add => format!("Add {}", change.label),
            ChangeAction::Update => format!("Update {}", change.label),
            ChangeAction::Delete => format!("Delete {}", change.label),
            ChangeAction::Rename => match &change.old_label {
                Some(old_label) => format!("Rename {old_label} to {}", change.label),
                None => format!("Rename {}", change.label),
            },
        })),
        changes => {
            let action = group_action(changes.iter().map(|change| change.action));
            Some(limit_subject(format!(
                "{} {}",
                action.verb(),
                count_phrase(changes.len(), "note", "notes")
            )))
        }
    }
}

fn describe_group(changes: &[&TreeChange], singular: &str, plural: &str) -> Option<String> {
    let action = group_action(changes.iter().map(|change| change.action));
    Some(limit_subject(format!(
        "{} {}",
        action.verb(),
        count_phrase(changes.len(), singular, plural)
    )))
}

fn group_action(actions: impl Iterator<Item = ChangeAction>) -> ChangeAction {
    let mut actions = actions.peekable();
    let Some(first) = actions.peek().copied() else {
        return ChangeAction::Update;
    };
    if actions.all(|action| action == first) {
        first
    } else {
        ChangeAction::Update
    }
}

impl ChangeAction {
    fn verb(self) -> &'static str {
        match self {
            ChangeAction::Add => "Add",
            ChangeAction::Update => "Update",
            ChangeAction::Delete => "Delete",
            ChangeAction::Rename => "Rename",
        }
    }
}

fn note_change(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    change: &TreeChange,
) -> Option<NoteChange> {
    let label = staged_note_label(repo, parent, tree, change)?;
    let old_label = change
        .old_path
        .as_deref()
        .and_then(|old_path| old_note_label(repo, parent, old_path));
    Some(NoteChange {
        action: change.action,
        label,
        old_label,
    })
}

fn staged_note_label(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    change: &TreeChange,
) -> Option<String> {
    match change.action {
        ChangeAction::Delete => old_note_label(repo, parent, &change.path),
        _ => current_note_label(repo, tree, &change.path),
    }
}

fn current_note_label(repo: &Repository, tree: &Tree<'_>, path: &str) -> Option<String> {
    let fallback = note_label(path)?;
    Some(match note_title_from_tree(repo, tree, path) {
        Some(AuthoredNoteTitle::Public(title)) => title,
        Some(AuthoredNoteTitle::Private) => "private note".to_string(),
        None => fallback,
    })
}

fn old_note_label(repo: &Repository, parent: Option<&Commit<'_>>, path: &str) -> Option<String> {
    let fallback = note_label(path)?;
    let parent_tree = parent.and_then(|parent| parent.tree().ok());
    Some(
        match parent_tree
            .as_ref()
            .and_then(|tree| note_title_from_tree(repo, tree, path))
        {
            Some(AuthoredNoteTitle::Public(title)) => title,
            Some(AuthoredNoteTitle::Private) => "private note".to_string(),
            None => fallback,
        },
    )
}

fn note_title_from_tree(
    repo: &Repository,
    tree: &Tree<'_>,
    path: &str,
) -> Option<AuthoredNoteTitle> {
    let source = blob_text(repo, tree, path)?;
    if note_is_private(&source) {
        return Some(AuthoredNoteTitle::Private);
    }
    if daily_date(path).is_some() {
        return None;
    }
    authored_note_title(&source)
}

fn blob_text(repo: &Repository, tree: &Tree<'_>, path: &str) -> Option<String> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let object = entry.to_object(repo).ok()?;
    let blob = object.as_blob()?;
    std::str::from_utf8(blob.content()).ok().map(str::to_string)
}

fn note_label(path: &str) -> Option<String> {
    if let Some(date) = daily_date(path) {
        return Some(format!("daily note for {date}"));
    }

    let stem = path
        .strip_prefix("notes/")?
        .strip_suffix(".md")?
        .rsplit('/')
        .next()?;
    let label = humanize_stem(stem);
    (!label.is_empty()).then_some(label)
}

fn authored_note_title(source: &str) -> Option<AuthoredNoteTitle> {
    let split = split_frontmatter(source);
    frontmatter_title(split.raw)
        .or_else(|| first_h1(split.body))
        .map(|title| collapse_spaces(&title))
        .filter(|title| !title.is_empty())
        .map(AuthoredNoteTitle::Public)
}

fn note_is_private(source: &str) -> bool {
    split_frontmatter(source)
        .raw
        .is_some_and(frontmatter_private)
}

struct FrontmatterSplit<'source> {
    raw: Option<&'source str>,
    body: &'source str,
}

fn split_frontmatter(source: &str) -> FrontmatterSplit<'_> {
    let no_block = FrontmatterSplit {
        raw: None,
        body: source,
    };
    let Some(open_len) = fence_line_len(source) else {
        return no_block;
    };
    let rest = &source[open_len..];
    if let Some(close_len) = fence_line_len(rest) {
        return FrontmatterSplit {
            raw: Some(""),
            body: &rest[close_len..],
        };
    }

    let mut search_from = 0;
    while let Some(newline_at) = rest[search_from..].find('\n').map(|at| search_from + at) {
        let line_start = newline_at + 1;
        if let Some(close_len) = fence_line_len(&rest[line_start..]) {
            let raw_end = if newline_at > 0 && rest.as_bytes()[newline_at - 1] == b'\r' {
                newline_at - 1
            } else {
                newline_at
            };
            return FrontmatterSplit {
                raw: Some(&rest[..raw_end]),
                body: &rest[line_start + close_len..],
            };
        }
        search_from = line_start;
    }
    no_block
}

fn fence_line_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("---")?;
    let bytes = rest.as_bytes();
    let mut index = 0;
    while index < bytes.len() && (bytes[index] == b' ' || bytes[index] == b'\t') {
        index += 1;
    }
    match bytes.get(index) {
        None => Some(3 + index),
        Some(b'\n') => Some(3 + index + 1),
        Some(b'\r') if bytes.get(index + 1) == Some(&b'\n') => Some(3 + index + 2),
        _ => None,
    }
}

fn frontmatter_title(raw: Option<&str>) -> Option<String> {
    frontmatter_scalar(raw?, "title").filter(|title| !title.trim().is_empty())
}

fn frontmatter_private(raw: &str) -> bool {
    frontmatter_scalar(raw, "private")
        .map(|value| {
            matches!(
                value.trim().to_lowercase().as_str(),
                "true" | "yes" | "on" | "1"
            )
        })
        .unwrap_or(false)
}

fn frontmatter_scalar(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let Some((candidate, value)) = line.split_once(':') else {
            continue;
        };
        if candidate.trim() == key {
            return Some(unquote_scalar(value.trim()));
        }
    }
    None
}

fn unquote_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let quote = bytes[0];
        if quote == b'"' || quote == b'\'' {
            if let Some(end) = trimmed[1..]
                .bytes()
                .position(|byte| byte == quote)
                .map(|index| index + 1)
            {
                let trailing = trimmed[end + 1..].trim_start();
                if trailing.is_empty() || trailing.starts_with('#') {
                    return trimmed[1..end].to_string();
                }
            }
        }
    }
    trimmed
        .split_once(" #")
        .map(|(head, _comment)| head)
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

fn first_h1(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let mut in_fence = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(heading) = atx_h1(trimmed) {
            return Some(heading);
        }
        if index + 1 < lines.len() && is_setext_h1(lines[index + 1]) {
            let heading = clean_heading_text(line);
            if !heading.is_empty() {
                return Some(heading);
            }
        }
    }
    None
}

fn atx_h1(line: &str) -> Option<String> {
    let rest = line.strip_prefix('#')?;
    if rest.starts_with('#') {
        return None;
    }
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let heading = clean_heading_text(rest);
    (!heading.is_empty()).then_some(heading)
}

fn is_setext_h1(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.chars().all(|character| character == '=')
}

fn clean_heading_text(raw: &str) -> String {
    let text = raw
        .trim()
        .trim_end_matches('#')
        .trim_end()
        .trim_end_matches('#')
        .trim();
    text.to_string()
}

fn daily_date(path: &str) -> Option<&str> {
    let date = path.strip_prefix("daily/")?.strip_suffix(".md")?;
    is_date_shaped(date).then_some(date)
}

fn is_date_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn humanize_stem(stem: &str) -> String {
    let normalized = collapse_spaces(
        &stem
            .chars()
            .map(|character| match character {
                '-' | '_' => ' ',
                character if character.is_control() => ' ',
                character => character,
            })
            .collect::<String>(),
    );
    if normalized.chars().any(char::is_uppercase) {
        return normalized;
    }
    title_case(&normalized)
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            first.to_uppercase().chain(chars).collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn collapse_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn count_phrase(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("1 {singular}")
    } else {
        format!("{count} {plural}")
    }
}

fn is_backup_metadata_path(path: &str) -> bool {
    matches!(path, ".gitignore" | ".gitattributes")
}

fn is_attachment_path(path: &str) -> bool {
    path.starts_with("assets/") || path.starts_with("audio-memos/")
}

fn limit_subject(subject: String) -> String {
    const MAX_SUBJECT_CHARS: usize = 72;
    if subject.chars().count() <= MAX_SUBJECT_CHARS {
        return subject;
    }
    subject
        .chars()
        .take(MAX_SUBJECT_CHARS.saturating_sub(3))
        .chain("...".chars())
        .collect()
}
