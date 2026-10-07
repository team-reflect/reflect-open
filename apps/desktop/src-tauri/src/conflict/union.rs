//! Append-union: the daily-note rule. Two devices captured into the same note
//! while apart — both versions share a common prefix (the note as last synced,
//! or the template seed both devices created it from) and diverge only by what
//! each appended. Keep the prefix and both tails, older side's tail first.
//!
//! The guard that keeps this from mangling *edits*: the two tails must be
//! line-disjoint. A mid-note edit puts the note's own following lines in both
//! tails (they overlap), which refuses the union and leaves the merge to the
//! next rule — never a silently duplicated half-note.

/// Union `first` and `second` when they diverge append-only. `None` when the
/// shape doesn't qualify (overlapping tails — a real edit, not an append).
pub(super) fn append_union(first: &str, second: &str) -> Option<String> {
    let first_lines: Vec<&str> = first.split('\n').collect();
    let second_lines: Vec<&str> = second.split('\n').collect();

    let shared = first_lines
        .iter()
        .zip(second_lines.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let first_tail = trim_trailing_blank(&first_lines[shared..]);
    let second_tail = trim_trailing_blank(&second_lines[shared..]);

    // One side is a pure prefix of the other: the longer side already holds
    // everything.
    if first_tail.is_empty() {
        return Some(second.to_string());
    }
    if second_tail.is_empty() {
        return Some(first.to_string());
    }

    // Overlapping non-blank lines mean the divergence isn't append-shaped.
    let first_set: std::collections::BTreeSet<&str> = first_tail
        .iter()
        .copied()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if second_tail
        .iter()
        .any(|line| !line.trim().is_empty() && first_set.contains(line))
    {
        return None;
    }

    let mut merged: Vec<&str> = Vec::new();
    merged.extend_from_slice(&first_lines[..shared]);
    merged.extend_from_slice(first_tail);
    merged.extend_from_slice(second_tail);
    let mut out = merged.join("\n");
    // Blank trailing pieces were trimmed off the tails; restore the single
    // trailing newline notes carry.
    if (first.ends_with('\n') || second.ends_with('\n')) && !out.ends_with('\n') {
        out.push('\n');
    }
    Some(out)
}

/// Drop trailing blank pieces (the empty split artifact of a trailing newline
/// plus any blank last lines) so tail comparison sees real content only.
fn trim_trailing_blank<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    &lines[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_devices_appended_to_the_same_daily_note() {
        let first = "# 2026-07-04\n\n- morning standup\n- mac task\n";
        let second = "# 2026-07-04\n\n- morning standup\n- phone capture\n";
        assert_eq!(
            append_union(first, second),
            Some("# 2026-07-04\n\n- morning standup\n- mac task\n- phone capture\n".to_string())
        );
    }

    #[test]
    fn a_pure_append_keeps_the_longer_side() {
        let first = "# Note\n\n- a\n";
        let second = "# Note\n\n- a\n- b\n";
        assert_eq!(append_union(first, second), Some(second.to_string()));
        assert_eq!(append_union(second, first), Some(second.to_string()));
    }

    #[test]
    fn creation_collision_with_no_shared_content_unions_both() {
        // Two devices created today's note offline with different content and
        // no template seed: nothing shared, keep both bodies.
        let first = "- from the mac\n";
        let second = "- from the phone\n";
        assert_eq!(
            append_union(first, second),
            Some("- from the mac\n- from the phone\n".to_string())
        );
    }

    #[test]
    fn a_mid_note_edit_refuses_the_union() {
        // First edited line two; second appended. Tails overlap on "- c".
        let first = "- a\n- B\n- c\n";
        let second = "- a\n- b\n- c\n- d\n";
        assert_eq!(append_union(first, second), None);
    }

    #[test]
    fn identical_up_to_trailing_blank_lines_keeps_one_side() {
        // Both tails are blank after trimming; the first-tail-empty arm wins,
        // so the second side comes back. Which side is irrelevant (the ladder
        // catches whitespace-equality earlier) — determinism is what matters.
        let first = "- a\n";
        let second = "- a\n\n";
        assert_eq!(append_union(first, second), Some(second.to_string()));
    }
}
