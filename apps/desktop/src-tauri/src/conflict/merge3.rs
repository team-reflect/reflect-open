//! Three-way text merge over the vendored libgit2 (`git2::merge_file`), run
//! buffer-level with no repository.

use git2::{merge_file, MergeFileInput, MergeFileOptions};

use crate::error::{AppError, AppResult};

use super::ConflictSide;

/// Merge `first`/`second` over `base`. `None` when hunks overlap. The result
/// depends on the order of the sides; libgit2 requires labels.
pub(crate) fn diff3(
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
        .our_label("ours")
        .their_label("theirs")
        .style_standard(true);

    let result = merge_file(&ancestor, &ours, &theirs, Some(&mut opts))
        .map_err(|err| AppError::io(format!("three-way merge failed: {err}")))?;
    let content = String::from_utf8(result.content().to_vec())
        .map_err(|err| AppError::io(format!("merge produced non-UTF-8 output: {err}")))?;
    Ok(result.is_automergeable().then_some(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(content: &str) -> ConflictSide {
        ConflictSide {
            content: content.to_string(),
            modified_ms: 0,
        }
    }

    #[test]
    fn disjoint_edits_merge_clean() {
        let base = "alpha\nmiddle\nomega\n";
        let first = side("ALPHA\nmiddle\nomega\n");
        let second = side("alpha\nmiddle\nOMEGA\n");
        assert_eq!(
            diff3(base, &first, &second).unwrap(),
            Some("ALPHA\nmiddle\nOMEGA\n".to_string())
        );
    }

    #[test]
    fn overlapping_edits_return_none() {
        let base = "line\n";
        let first = side("mac line\n");
        let second = side("phone line\n");
        assert_eq!(diff3(base, &first, &second).unwrap(), None);
    }

    #[test]
    fn both_appending_at_the_end_returns_none_rather_than_reordering() {
        let base = "# 2026-07-04\n\n- seed\n";
        let first = side("# 2026-07-04\n\n- seed\n- from mac\n");
        let second = side("# 2026-07-04\n\n- seed\n- from phone\n");
        assert_eq!(diff3(base, &first, &second).unwrap(), None);
    }
}
