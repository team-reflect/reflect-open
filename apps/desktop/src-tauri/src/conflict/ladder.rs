//! The resolution ladder (Plan 21): one conflicted note pair in, one
//! deterministic [`Resolution`] out. First matching rule wins:
//!
//! 1. **Identical** → nothing to write.
//! 2. **Whitespace-equal** → keep the newer side.
//! 3. **A side already carries markers** (a file an older version left
//!    behind) → keep the newer side whole: the marked file holds both
//!    originals in its hunks, and the clean one is either the user's
//!    resolution of it (newer) or stale pre-conflict content (older).
//! 4. **Merge-loop breaker** → keep the newer side whole. Base-dependent
//!    auto-merges on two devices can swap contents forever; a choice that
//!    depends only on the ordered pair ends the loop on both.
//! 5. **Three-way merge** over the shadow base, when one exists and the
//!    edits do not overlap.
//! 6. **Key-wise frontmatter** when only the header diverged.
//! 7. **Append-union** when both sides only appended.
//! 8. **Total merge** ([`super::total`]): overlapping edits interleaved word
//!    by word, both sides' text kept.
//!
//! Rules 1 to 7 are exact: every line of the result comes from one side.
//! Rules 4 and 8 are [`Resolution::Reconciled`], and callers archive both
//! sides before writing them.
//!
//! Every rule sees the sides ordered by `(modified_ms, content)` — shared
//! version metadata — so concurrent resolution on two devices converges.

use crate::error::AppResult;

use super::frontmatter;
use super::markers;
use super::merge3::diff3;
use super::total;
use super::union::append_union;
use super::{ConflictSide, Resolution};

/// Everything the ladder needs to know about one conflicted note.
pub struct ConflictInput<'a> {
    /// The shadow base (last synced content), when the store has one.
    pub base: Option<&'a str>,
    /// The two conflicting versions, in any order.
    pub sides: (ConflictSide, ConflictSide),
    /// True when the sweep recognized this exact content pair from a previous
    /// auto-merge — the loop breaker (rule 4).
    pub merge_loop_detected: bool,
}

/// Run the ladder. Pure and deterministic: same input pair (either order) →
/// same bytes, on any device.
pub fn resolve(input: ConflictInput<'_>) -> AppResult<Resolution> {
    let (first, second) = ordered(input.sides.0, input.sides.1);

    if first.content == second.content {
        return Ok(Resolution::AlreadyResolved);
    }
    if normalized(&first.content) == normalized(&second.content) {
        return Ok(Resolution::Merged {
            content: second.content,
        });
    }
    if markers::contains_conflict_markers(&first.content)
        || markers::contains_conflict_markers(&second.content)
    {
        return Ok(Resolution::Merged {
            content: second.content,
        });
    }
    if input.merge_loop_detected {
        return Ok(Resolution::Reconciled {
            content: second.content,
        });
    }

    if let Some(base) = input.base {
        if let Some(content) = diff3(base, &first, &second)? {
            return Ok(Resolution::Merged { content });
        }
    }

    if let Some(content) = merge_frontmatter_only(input.base, &first, &second) {
        return Ok(Resolution::Merged { content });
    }

    if let Some(content) = append_union(&first.content, &second.content) {
        return Ok(Resolution::Merged { content });
    }

    Ok(Resolution::Reconciled {
        content: total::merge(input.base.unwrap_or(""), &first.content, &second.content),
    })
}

/// Deterministic side order: ascending `(modified_ms, content)`. Timestamps
/// come from the provider's version metadata, identical on every device; the
/// content tiebreak covers equal stamps.
fn ordered(a: ConflictSide, b: ConflictSide) -> (ConflictSide, ConflictSide) {
    if (a.modified_ms, &a.content) <= (b.modified_ms, &b.content) {
        (a, b)
    } else {
        (b, a)
    }
}

/// Whitespace-insensitive equality shape: trailing whitespace per line and
/// trailing blank lines don't count as divergence.
fn normalized(content: &str) -> String {
    let mut lines: Vec<&str> = content.split('\n').map(str::trim_end).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Rule 6: identical bodies, divergent flat frontmatter → key-wise merge.
fn merge_frontmatter_only(
    base: Option<&str>,
    first: &ConflictSide,
    second: &ConflictSide,
) -> Option<String> {
    let first_split = frontmatter::split(&first.content);
    let second_split = frontmatter::split(&second.content);
    if first_split.body != second_split.body {
        return None;
    }
    let base_header = base.map(|content| frontmatter::split(content).header);
    let merged = frontmatter::merge_headers(
        base_header.flatten(),
        first_split.header.unwrap_or(""),
        second_split.header.unwrap_or(""),
    )?;
    if merged.is_empty() {
        return Some(first_split.body.to_string());
    }
    Some(format!("---\n{merged}\n---\n{}", first_split.body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(content: &str, label: &str, modified_ms: u64) -> ConflictSide {
        ConflictSide {
            content: content.to_string(),
            label: label.to_string(),
            modified_ms,
        }
    }

    fn input<'a>(base: Option<&'a str>, sides: (ConflictSide, ConflictSide)) -> ConflictInput<'a> {
        ConflictInput {
            base,
            sides,
            merge_loop_detected: false,
        }
    }

    #[test]
    fn identical_content_is_already_resolved() {
        let result = resolve(input(
            None,
            (side("same\n", "Mac", 1), side("same\n", "iPhone", 2)),
        ))
        .unwrap();
        assert_eq!(result, Resolution::AlreadyResolved);
    }

    #[test]
    fn whitespace_noise_keeps_the_newer_side() {
        let result = resolve(input(
            None,
            (side("text  \n\n", "Mac", 1), side("text\n", "iPhone", 2)),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "text\n".to_string()
            }
        );
    }

    #[test]
    fn disjoint_edits_over_a_base_merge_clean() {
        let base = "# T\n\nalpha\n\nomega\n";
        let result = resolve(input(
            Some(base),
            (
                side("# T\n\nALPHA\n\nomega\n", "Mac", 1),
                side("# T\n\nalpha\n\nOMEGA\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "# T\n\nALPHA\n\nOMEGA\n".to_string()
            }
        );
    }

    #[test]
    fn overlapping_edits_reconcile_without_markers() {
        // The same line rewritten on both sides, with a shared tail after it
        // (so the append-union guard refuses).
        let base = "a\nline\ntail\n";
        let result = resolve(input(
            Some(base),
            (
                side("a\nmac\ntail\n", "Mac", 1),
                side("a\nphone\ntail\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        let Resolution::Reconciled { content } = result else {
            panic!("expected a reconciled merge, got {result:?}");
        };
        assert!(!content.contains("<<<<<<< "), "{content}");
        assert!(
            content.contains("mac") && content.contains("phone"),
            "{content}"
        );
    }

    #[test]
    fn whole_note_rewrites_on_both_sides_keep_both_lines() {
        let result = resolve(input(
            Some("line\n"),
            (side("mac\n", "Mac", 1), side("phone\n", "iPhone", 2)),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "mac\nphone\n".to_string()
            }
        );
    }

    #[test]
    fn daily_notes_union_after_a_failed_three_way_merge() {
        // Both devices appended to the synced daily note — diff3 conflicts
        // (same-position append), the union rule resolves it.
        let base = "# 2026-07-04\n\n- seed\n";
        let result = resolve(input(
            Some(base),
            (
                side("# 2026-07-04\n\n- seed\n- mac\n", "Mac", 1),
                side("# 2026-07-04\n\n- seed\n- phone\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "# 2026-07-04\n\n- seed\n- mac\n- phone\n".to_string()
            }
        );
    }

    #[test]
    fn union_orders_tails_by_timestamp_not_argument_order() {
        let older = side("- seed\n- older tail\n", "Mac", 1);
        let newer = side("- seed\n- newer tail\n", "iPhone", 2);
        // Same pair, both argument orders → identical bytes (convergence).
        let one = resolve(input(None, (older.clone(), newer.clone()))).unwrap();
        let two = resolve(input(None, (newer, older))).unwrap();
        assert_eq!(one, two);
        assert_eq!(
            one,
            Resolution::Merged {
                content: "- seed\n- older tail\n- newer tail\n".to_string()
            }
        );
    }

    #[test]
    fn any_note_unions_disjoint_appends() {
        let result = resolve(input(
            None,
            (
                side("- a\n- mac\n", "Mac", 1),
                side("- a\n- phone\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "- a\n- mac\n- phone\n".to_string()
            }
        );
    }

    #[test]
    fn frontmatter_only_divergence_merges_key_wise() {
        let base = "---\nid: abc\n---\n# Body\n";
        let result = resolve(input(
            Some(base),
            (
                side("---\nid: abc\nisPinned: true\n---\n# Body\n", "Mac", 1),
                side("---\nid: abc\nprivate: true\n---\n# Body\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: "---\nid: abc\nisPinned: true\nprivate: true\n---\n# Body\n".to_string()
            }
        );
    }

    #[test]
    fn a_marked_side_never_gains_nested_markers() {
        let marked = "<<<<<<< Mac\nmine\n=======\ntheirs\n>>>>>>> iPhone\n";
        let clean = "user resolved\n";
        // The clean side is newer — the user resolved on the other device.
        let result = resolve(input(
            None,
            (side(marked, "Mac", 1), side(clean, "iPhone", 2)),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: clean.to_string()
            }
        );
        // The marked side is newer — markers just materialized; keep them.
        let result = resolve(input(
            None,
            (side(clean, "iPhone", 1), side(marked, "Mac", 2)),
        ))
        .unwrap();
        assert_eq!(
            result,
            Resolution::Merged {
                content: marked.to_string()
            }
        );
    }

    #[test]
    fn the_loop_breaker_keeps_the_newer_side() {
        let mut conflict = input(
            Some("base\n"),
            (side("merge A\n", "Mac", 1), side("merge B\n", "iPhone", 2)),
        );
        conflict.merge_loop_detected = true;
        assert_eq!(
            resolve(conflict).unwrap(),
            Resolution::Reconciled {
                content: "merge B\n".to_string()
            }
        );
    }

    #[test]
    fn resolution_is_argument_order_independent() {
        let a = side("# T\n\nmac edit\n", "Mac", 5);
        let b = side("# T\n\nphone edit\n", "iPhone", 5); // equal stamps → content tiebreak
        let one = resolve(input(None, (a.clone(), b.clone()))).unwrap();
        let two = resolve(input(None, (b, a))).unwrap();
        assert_eq!(one, two);
    }
}
