//! Three-way text merge over the vendored libgit2 (`git2::merge_file`), the
//! xdiff engine, run buffer-level with no repository. Only a clean merge is
//! used; overlapping hunks are reported as `None` and resolved elsewhere.

use git2::{merge_file, MergeFileInput, MergeFileOptions};

use crate::error::{AppError, AppResult};

use super::ConflictSide;

/// Merge `first`/`second` over `base`: the merged text when no hunks
/// overlap, else `None`.
pub(super) fn diff3(
    base: &str,
    first: &ConflictSide,
    second: &ConflictSide,
) -> AppResult<Option<String>> {
    // git2's Repository entry points run libgit2's guarded global init, but
    // the free `merge_file` function skips it and traps when it runs first
    // (tls/allocator state). `Buf::new` is the cheapest public call that
    // performs the same guarded init.
    let _ = git2::Buf::new();
    // libgit2 asserts on a NULL input path (git2's own smoke test sets one on
    // every input); the value is only used for rename detection we don't need.
    let path = std::path::Path::new("note.md");
    let mut ancestor = MergeFileInput::new();
    ancestor.content(base.as_bytes()).path(path);
    let mut ours = MergeFileInput::new();
    ours.content(first.content.as_bytes()).path(path);
    let mut theirs = MergeFileInput::new();
    theirs.content(second.content.as_bytes()).path(path);

    let mut opts = MergeFileOptions::new();
    opts.ancestor_label("base")
        .our_label(&first.label)
        .their_label(&second.label)
        .style_standard(true);

    let result = merge_file(&ancestor, &ours, &theirs, Some(&mut opts))
        .map_err(|err| AppError::io(format!("three-way merge failed: {err}")))?;
    if !result.is_automergeable() {
        return Ok(None);
    }
    let content = String::from_utf8(result.content().to_vec())
        .map_err(|err| AppError::io(format!("merge produced non-UTF-8 output: {err}")))?;
    Ok(Some(content))
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
    fn disjoint_edits_merge_clean() {
        let base = "alpha\nmiddle\nomega\n";
        let first = side("ALPHA\nmiddle\nomega\n", "Mac");
        let second = side("alpha\nmiddle\nOMEGA\n", "iPhone");
        assert_eq!(
            diff3(base, &first, &second).unwrap(),
            Some("ALPHA\nmiddle\nOMEGA\n".to_string())
        );
    }

    #[test]
    fn overlapping_edits_report_no_merge() {
        let base = "line\n";
        let first = side("mac line\n", "Alex's MacBook Pro");
        let second = side("phone line\n", "Alex's iPhone");
        assert_eq!(diff3(base, &first, &second).unwrap(), None);
    }

    #[test]
    fn both_appending_at_the_end_conflicts_rather_than_reordering() {
        // The daily-note shape: diff3 alone cannot union same-position
        // appends — that is the ladder's append-union rule, not xdiff's job.
        let base = "# 2026-07-04\n\n- seed\n";
        let first = side("# 2026-07-04\n\n- seed\n- from mac\n", "Mac");
        let second = side("# 2026-07-04\n\n- seed\n- from phone\n", "iPhone");
        assert_eq!(diff3(base, &first, &second).unwrap(), None);
    }
}
