//! Conflict-marker detection: the Rust twin of
//! `packages/core/src/markdown/conflict-markers.ts`. Detection requires the
//! full `<<<<<<< ` → `=======` → `>>>>>>> ` sequence in order (same rule as
//! the TS detector, so both sides agree on what "carries a conflict" means).
//! Nothing here writes markers; files that carry them were left by older
//! versions.

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
