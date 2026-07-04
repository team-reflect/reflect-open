//! Conflict-marker primitives: the Rust twin of
//! `packages/core/src/markdown/conflict-markers.ts`. Detection requires the
//! full `<<<<<<< ` → `=======` → `>>>>>>> ` sequence in order (same rule as
//! the TS detector, so both sides agree on what "carries a conflict" means),
//! and the whole-note builder emits the exact grammar the indexer, protected
//! view, and resolution notice already handle.

use super::ConflictSide;

/// True when `source` contains a complete conflict-marker block.
pub fn contains_conflict_markers(source: &str) -> bool {
    let mut stage = 0u8; // 0 = want start, 1 = want separator, 2 = want end
    for line in source.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        match stage {
            0 if line.starts_with("<<<<<<< ") => stage = 1,
            1 if line == "=======" => stage = 2,
            2 if line.starts_with(">>>>>>> ") => return true,
            _ => {}
        }
    }
    false
}

/// Whole-note markers for **three or more** sides: the first block carries
/// the first two, and every further side appends a block whose ours-half is
/// empty. Mechanically compatible with the splice grammar — `ours` keeps the
/// first side, `theirs` keeps every other side, `both` keeps everything — so
/// no side's content can be lost by any resolution choice. Used when a
/// multi-version fold hits overlapping edits: pairwise marker output can't
/// be folded again (nesting corrupts the grammar), and every side must stay
/// in the note.
pub(crate) fn stacked_whole_note_markers(sides: &[ConflictSide]) -> String {
    debug_assert!(sides.len() >= 2, "stacking needs at least two sides");
    let mut out = whole_note_markers(&sides[0], &sides[1]);
    for side in &sides[2..] {
        out.push_str(&format!(
            "<<<<<<< {}\n=======\n{}\n>>>>>>> {}\n",
            marker_label(&sides[0].label),
            side.content.trim_end_matches('\n'),
            marker_label(&side.label),
        ));
    }
    out
}

/// A single whole-note marker block holding both sides, used when there is no
/// base to produce hunk-level markers from. Output depends only on the
/// (already deterministically ordered) sides, never on which device runs it.
pub(super) fn whole_note_markers(first: &ConflictSide, second: &ConflictSide) -> String {
    format!(
        "<<<<<<< {}\n{}\n=======\n{}\n>>>>>>> {}\n",
        marker_label(&first.label),
        first.content.trim_end_matches('\n'),
        second.content.trim_end_matches('\n'),
        marker_label(&second.label),
    )
}

/// Labels must be one non-empty line — the detector keys on `"<<<<<<< "` with
/// a trailing space, and an embedded newline would corrupt the grammar.
fn marker_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "unknown device".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(content: &str, label: &str) -> ConflictSide {
        ConflictSide {
            content: content.to_string(),
            label: label.to_string(),
            modified_ms: 0,
        }
    }

    #[test]
    fn detects_only_the_full_sequence_in_order() {
        assert!(contains_conflict_markers(
            "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n"
        ));
        // Prose mentioning a marker line is not a conflict.
        assert!(!contains_conflict_markers("<<<<<<< just talking\n"));
        assert!(!contains_conflict_markers(
            "=======\n>>>>>>> b\n<<<<<<< a\n"
        ));
        // Bare `<<<<<<<` without the space+label is not the grammar.
        assert!(!contains_conflict_markers(
            "<<<<<<<\nx\n=======\ny\n>>>>>>> b\n"
        ));
    }

    #[test]
    fn whole_note_markers_round_trip_through_detection() {
        let marked = whole_note_markers(&side("mine\n", "Mac"), &side("theirs\n", "iPhone"));
        assert!(contains_conflict_markers(&marked));
        assert_eq!(
            marked,
            "<<<<<<< Mac\nmine\n=======\ntheirs\n>>>>>>> iPhone\n"
        );
    }

    #[test]
    fn labels_are_sanitized_to_one_nonempty_line() {
        let marked = whole_note_markers(&side("a", "Mac\nBook"), &side("b", "  "));
        assert!(marked.contains("<<<<<<< Mac Book\n"));
        assert!(marked.contains(">>>>>>> unknown device\n"));
    }
}
