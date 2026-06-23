//! Derive concise backup commit subjects from staged graph paths.

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

/// Return a path-derived commit subject, falling back when the staged tree is
/// metadata-only or otherwise too noisy to summarize clearly.
pub(super) fn message_for_commit(
    repo: &Repository,
    parent: Option<&Commit<'_>>,
    tree: &Tree<'_>,
    fallback: &str,
) -> AppResult<String> {
    let changes = tree_changes(repo, parent, tree)?;
    Ok(describe_changes(&changes).unwrap_or_else(|| fallback.to_string()))
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
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(tree), Some(&mut options))?;

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

fn describe_changes(changes: &[TreeChange]) -> Option<String> {
    let content_changes: Vec<&TreeChange> = changes
        .iter()
        .filter(|change| !is_backup_metadata_path(&change.path))
        .collect();
    if content_changes.is_empty() {
        return None;
    }

    let note_changes: Vec<NoteChange> = content_changes
        .iter()
        .filter_map(|change| note_change(change))
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
        return Some(limit_subject(format!(
            "Update {} and {}",
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

fn note_change(change: &TreeChange) -> Option<NoteChange> {
    let label = note_label(&change.path)?;
    let old_label = change.old_path.as_deref().and_then(note_label);
    Some(NoteChange {
        action: change.action,
        label,
        old_label,
    })
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
