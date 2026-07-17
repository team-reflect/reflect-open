//! The resolution ladder (Plan 21): one conflicted note pair in, one
//! deterministic [`Resolution`] out. First matching rule wins:
//!
//! 1. **Identical** → nothing to write.
//! 2. **Whitespace-equal** → keep the newer side.
//! 3. **A side already carries markers** → keep the newer side whole. The
//!    marked file holds both originals in its hunks and the clean one is
//!    either the user's resolution of it (newer) or stale pre-conflict
//!    content (older) — and nesting new markers around old ones would corrupt
//!    the grammar the resolution UI splices by.
//! 4. **Merge-loop breaker** → straight to whole-note markers (base-dependent
//!    auto-merges on two devices can swap contents forever; markers depend
//!    only on the ordered pair, so both devices emit identical bytes and the
//!    loop dies).
//! 5. **Three-way merge** over the shadow base, when one exists.
//! 6. **Key-wise frontmatter** when only the header diverged.
//! 7. **Append-union** for daily notes and creation collisions.
//! 8. **Markers** — hunk-level from the three-way merge when a base existed,
//!    whole-note otherwise.
//!
//! Every rule sees the sides ordered by `(modified_ms, content)` — shared
//! version metadata — so concurrent resolution on two devices converges.

use crate::error::AppResult;

use super::frontmatter;
use super::markers;
use super::merge3::{diff3, Diff3Outcome};
use super::union::append_union;
use super::{ConflictSide, Resolution};

/// Everything the ladder needs to know about one conflicted note.
pub struct ConflictInput<'a> {
    /// Graph-relative path — `journal/` notes qualify for append-union.
    pub path: &'a str,
    /// The shadow base (last synced content), when the store has one.
    pub base: Option<&'a str>,
    /// The two conflicting versions, in any order.
    pub sides: (ConflictSide, ConflictSide),
    /// True when the pair comes from a creation collision (`note 2.md`):
    /// append-union applies regardless of directory.
    pub creation_collision: bool,
    /// True when the sweep recognized this exact content pair from a previous
    /// auto-merge — the deterministic-markers loop breaker (rule 4).
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
        return Ok(Resolution::Marked {
            content: markers::whole_note_markers(&first, &second),
        });
    }

    let mut marked_from_diff3: Option<String> = None;
    if let Some(base) = input.base {
        match diff3(base, &first, &second)? {
            Diff3Outcome::Clean(content) => return Ok(Resolution::Merged { content }),
            Diff3Outcome::Conflicted(content) => marked_from_diff3 = Some(content),
        }
    }

    if let Some(content) = merge_frontmatter_only(input.base, &first, &second) {
        return Ok(Resolution::Merged { content });
    }

    if input.creation_collision || input.path.starts_with("journal/") {
        if let Some(content) = append_union(&first.content, &second.content) {
            return Ok(Resolution::Merged { content });
        }
    }

    Ok(Resolution::Marked {
        content: marked_from_diff3.unwrap_or_else(|| markers::whole_note_markers(&first, &second)),
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

    fn input<'a>(
        path: &'a str,
        base: Option<&'a str>,
        sides: (ConflictSide, ConflictSide),
    ) -> ConflictInput<'a> {
        ConflictInput {
            path,
            base,
            sides,
            creation_collision: false,
            merge_loop_detected: false,
        }
    }

    #[test]
    fn identical_content_is_already_resolved() {
        let result = resolve(input(
            "notes/a.md",
            None,
            (side("same\n", "Mac", 1), side("same\n", "iPhone", 2)),
        ))
        .unwrap();
        assert_eq!(result, Resolution::AlreadyResolved);
    }

    #[test]
    fn whitespace_noise_keeps_the_newer_side() {
        let result = resolve(input(
            "notes/a.md",
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
            "notes/a.md",
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
    fn overlapping_edits_over_a_base_mark_with_hunk_level_labels() {
        let base = "line\n";
        let result = resolve(input(
            "notes/a.md",
            Some(base),
            (side("mac\n", "Mac", 1), side("phone\n", "iPhone", 2)),
        ))
        .unwrap();
        let Resolution::Marked { content } = result else {
            panic!("expected markers, got {result:?}");
        };
        assert!(content.contains("<<<<<<< Mac"));
        assert!(content.contains(">>>>>>> iPhone"));
    }

    #[test]
    fn daily_notes_union_after_a_failed_three_way_merge() {
        // Both devices appended to the synced daily note — diff3 conflicts
        // (same-position append), the union rule resolves it.
        let base = "# 2026-07-04\n\n- seed\n";
        let result = resolve(input(
            "journal/2026-07-04.md",
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
        let one = resolve(input("journal/x.md", None, (older.clone(), newer.clone()))).unwrap();
        let two = resolve(input("journal/x.md", None, (newer, older))).unwrap();
        assert_eq!(one, two);
        assert_eq!(
            one,
            Resolution::Merged {
                content: "- seed\n- older tail\n- newer tail\n".to_string()
            }
        );
    }

    #[test]
    fn non_daily_notes_do_not_union_without_a_collision_flag() {
        let result = resolve(input(
            "notes/topic.md",
            None,
            (
                side("- a\n- mac\n", "Mac", 1),
                side("- a\n- phone\n", "iPhone", 2),
            ),
        ))
        .unwrap();
        assert!(matches!(result, Resolution::Marked { .. }));
    }

    #[test]
    fn creation_collisions_union_anywhere() {
        let mut conflict = input(
            "notes/topic.md",
            None,
            (side("- mac\n", "Mac", 1), side("- phone\n", "iPhone", 2)),
        );
        conflict.creation_collision = true;
        assert_eq!(
            resolve(conflict).unwrap(),
            Resolution::Merged {
                content: "- mac\n- phone\n".to_string()
            }
        );
    }

    #[test]
    fn frontmatter_only_divergence_merges_key_wise() {
        let base = "---\nid: abc\n---\n# Body\n";
        let result = resolve(input(
            "notes/a.md",
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
            "notes/a.md",
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
            "notes/a.md",
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
    fn the_loop_breaker_forces_deterministic_whole_note_markers() {
        let mut conflict = input(
            "notes/a.md",
            Some("base\n"),
            (side("merge A\n", "Mac", 1), side("merge B\n", "iPhone", 2)),
        );
        conflict.merge_loop_detected = true;
        let Resolution::Marked { content } = resolve(conflict).unwrap() else {
            panic!("loop breaker must mark");
        };
        assert_eq!(
            content,
            "<<<<<<< Mac\nmerge A\n=======\nmerge B\n>>>>>>> iPhone\n"
        );
    }

    #[test]
    fn resolution_is_argument_order_independent() {
        let a = side("# T\n\nmac edit\n", "Mac", 5);
        let b = side("# T\n\nphone edit\n", "iPhone", 5); // equal stamps → content tiebreak
        let one = resolve(input("notes/a.md", None, (a.clone(), b.clone()))).unwrap();
        let two = resolve(input("notes/a.md", None, (b, a))).unwrap();
        assert_eq!(one, two);
    }
}
