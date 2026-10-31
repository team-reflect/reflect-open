//! Key-wise frontmatter merge: when both sides carry the same body and only
//! the `---` header diverged (pin state on one device, a flag on the other),
//! line-level merging is too blunt — merge per key instead.
//!
//! Deliberately conservative: only **flat** `key: value` headers qualify
//! (every Reflect-written frontmatter is; Plan 07b holds the exact header
//! bytes). Anything else — nested YAML, continuation lines — is opaque and
//! falls through to the rest of the ladder. A key both sides changed to
//! different values is a real conflict and also falls through.

use std::collections::BTreeSet;

/// A note split at its frontmatter fence. `header` excludes the `---` fences;
/// `body` starts after the closing fence line.
pub struct SplitNote<'a> {
    pub header: Option<&'a str>,
    pub body: &'a str,
}

/// Split `source` into frontmatter and body. No frontmatter → header `None`.
pub fn split(source: &str) -> SplitNote<'_> {
    let Some(rest) = source.strip_prefix("---\n") else {
        return SplitNote {
            header: None,
            body: source,
        };
    };
    // The closing fence is a `---` line: either mid-file or as the last line.
    if let Some(end) = rest.find("\n---\n") {
        return SplitNote {
            header: Some(&rest[..end]),
            body: &rest[end + "\n---\n".len()..],
        };
    }
    if let Some(header) = rest.strip_suffix("\n---") {
        return SplitNote {
            header: Some(header),
            body: "",
        };
    }
    SplitNote {
        header: None,
        body: source,
    }
}

/// Merge two flat frontmatter headers key-wise against an optional base
/// header. Returns the merged header (no fences), or `None` when the shape
/// isn't flat or a key genuinely conflicts.
pub fn merge_headers(base: Option<&str>, first: &str, second: &str) -> Option<String> {
    let base_pairs = match base {
        Some(header) => parse_flat(header)?,
        None => Vec::new(),
    };
    let first_pairs = parse_flat(first)?;
    let second_pairs = parse_flat(second)?;

    let base_value = |key: &str| base_pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let mut merged: Vec<(String, String)> = Vec::new();
    let mut emitted: BTreeSet<String> = BTreeSet::new();

    // First side's key order wins the layout; the second side's new keys append.
    for (key, first_value) in &first_pairs {
        let second_value = second_pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v);
        let value = match second_value {
            Some(second_value) if second_value == first_value => first_value.clone(),
            Some(second_value) => match base_value(key) {
                // One side kept the base value: the other side's edit wins.
                Some(base) if base == first_value => second_value.clone(),
                Some(base) if base == second_value => first_value.clone(),
                _ => return None, // both changed the same key differently
            },
            None => match base_value(key) {
                // Present in base, deleted on the second side: deletion wins
                // only if the first side didn't also edit it.
                Some(base) if base == first_value => continue,
                Some(_) => return None,
                // New key on the first side only.
                None => first_value.clone(),
            },
        };
        merged.push((key.clone(), value));
        emitted.insert(key.clone());
    }
    for (key, second_value) in &second_pairs {
        if emitted.contains(key) {
            continue;
        }
        match base_value(key) {
            // Present in base, deleted on the first side.
            Some(base) if base == second_value => continue,
            Some(_) => return None,
            None => merged.push((key.clone(), second_value.clone())),
        }
    }

    Some(
        merged
            .into_iter()
            .map(|(key, value)| format!("{key}: {value}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Parse a header as flat `key: value` lines. Any other shape returns `None`.
fn parse_flat(header: &str) -> Option<Vec<(String, String)>> {
    let mut pairs = Vec::new();
    for line in header.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // Continuation/nested lines start with whitespace — not flat.
        if line.starts_with(' ') || line.starts_with('\t') {
            return None;
        }
        let (key, value) = line.split_once(':')?;
        let key = key.trim();
        if key.is_empty() {
            return None;
        }
        pairs.push((key.to_string(), value.trim().to_string()));
    }
    Some(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_finds_header_and_body() {
        let note = "---\nid: abc\nprivate: true\n---\n# Body\n";
        let parts = split(note);
        assert_eq!(parts.header, Some("id: abc\nprivate: true"));
        assert_eq!(parts.body, "# Body\n");
        assert_eq!(split("# No header\n").header, None);
    }

    #[test]
    fn disjoint_key_edits_merge() {
        let base = "id: abc";
        let first = "id: abc\nisPinned: true"; // pinned on the Mac
        let second = "id: abc\nprivate: true"; // marked private on the phone
        assert_eq!(
            merge_headers(Some(base), first, second),
            Some("id: abc\nisPinned: true\nprivate: true".to_string())
        );
    }

    #[test]
    fn the_edited_side_beats_the_side_that_kept_the_base_value() {
        let base = "id: abc\npinnedOrder: 2";
        let first = "id: abc\npinnedOrder: 2";
        let second = "id: abc\npinnedOrder: 5";
        assert_eq!(
            merge_headers(Some(base), first, second),
            Some("id: abc\npinnedOrder: 5".to_string())
        );
    }

    #[test]
    fn same_key_changed_differently_refuses() {
        let base = "pinnedOrder: 1";
        assert_eq!(
            merge_headers(Some(base), "pinnedOrder: 2", "pinnedOrder: 3"),
            None
        );
    }

    #[test]
    fn deletion_wins_only_against_an_unedited_value() {
        let base = "id: abc\nisPinned: true";
        // Second side unpinned (deleted the key); first side left it alone.
        assert_eq!(
            merge_headers(Some(base), "id: abc\nisPinned: true", "id: abc"),
            Some("id: abc".to_string())
        );
        // But a delete against an *edit* is a real conflict.
        assert_eq!(
            merge_headers(Some(base), "id: abc\nisPinned: false", "id: abc"),
            None
        );
    }

    #[test]
    fn without_a_base_only_disjoint_and_equal_keys_merge() {
        assert_eq!(
            merge_headers(None, "id: abc\nkind: template", "id: abc\nprivate: true"),
            Some("id: abc\nkind: template\nprivate: true".to_string())
        );
        assert_eq!(merge_headers(None, "id: abc", "id: xyz"), None);
    }

    #[test]
    fn nested_yaml_is_opaque() {
        assert_eq!(merge_headers(None, "list:\n  - a", "id: abc"), None);
    }
}
