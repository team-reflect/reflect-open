//! Append/append auto-merge for daily notes — the one content conflict safe
//! to resolve without review.
//!
//! Two devices appending to the same day's note (the canonical mobile
//! collision: phone and Mac both capture into today while the phone was
//! offline) produce a git conflict even though neither side touched what the
//! other wrote. When the merge base is an untouched, line-bounded prefix of
//! **both** sides, keeping the base plus both appended suffixes loses nothing
//! — so [`merge_appends`] resolves it instead of parking the note behind
//! conflict markers.
//!
//! Anything that is not this exact shape returns `None` and keeps the marker
//! flow: an edit inside the base region, a frontmatter change (frontmatter
//! lives at the top, so touching it always breaks the prefix; a side
//! *introducing* frontmatter over an empty base is rejected explicitly),
//! non-daily paths (the caller gates on [`is_daily_note_path`]), deletions,
//! and binary or non-UTF-8 content (also the caller's gate). A false-positive
//! auto-merge that loses or reorders user text is strictly worse than a
//! parked note.

use std::collections::HashSet;

/// Whether a graph-relative path is a daily note (`daily/YYYY-MM-DD.md`).
/// Shape-only, like `dateFromDailyPath` on the TS side — no calendar
/// validation.
pub(super) fn is_daily_note_path(path: &str) -> bool {
    let Some(date) = path
        .strip_prefix("daily/")
        .and_then(|rest| rest.strip_suffix(".md"))
    else {
        return false;
    };
    date.len() == 10
        && date.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// Merge two pure appends onto a shared base: `base` + ours' suffix + theirs'
/// suffix, in that fixed order (this device's entries first — the same
/// local-first order the conflict markers use, and deterministic because only
/// one device performs the merge; the other fast-forwards onto its result).
///
/// Returns `None` unless `base` is an untouched, line-bounded prefix of both
/// sides. Suffix lines theirs shares verbatim with ours (the same capture
/// arriving from both devices) are kept once — the whole-line,
/// trailing-`\r`-insensitive rule the capture drain's presence guard uses.
pub(super) fn merge_appends(base: &str, ours: &str, theirs: &str) -> Option<String> {
    let ours_suffix = appended_suffix(base, ours)?;
    let theirs_suffix = appended_suffix(base, theirs)?;
    if base.is_empty() && (starts_with_frontmatter(ours) || starts_with_frontmatter(theirs)) {
        // Both sides created the note independently and at least one opened
        // with frontmatter: concatenating would bury a `---` block mid-file.
        // This driver is body-only — park it for review.
        return None;
    }

    let mut merged =
        String::with_capacity(base.len() + ours_suffix.len() + theirs_suffix.len() + 1);
    merged.push_str(base);
    merged.push_str(ours_suffix);
    let Some(mut theirs_kept) = dedup_against(theirs_suffix, ours_suffix) else {
        return Some(merged);
    };
    if !base.is_empty() && !base.ends_with('\n') && merged.ends_with('\n') {
        // The base ended mid-line, so theirs' suffix opens with the newline
        // that terminated it — ours' suffix already supplied one. Dropping
        // the redundant terminator reproduces theirs' own line structure
        // instead of inserting a blank line.
        if let Some(rest) = theirs_kept
            .strip_prefix("\r\n")
            .or_else(|| theirs_kept.strip_prefix('\n'))
        {
            theirs_kept = rest.to_string();
        }
    }
    if !merged.is_empty() && !merged.ends_with('\n') && !starts_on_new_line(&theirs_kept) {
        // Ours ended mid-line; without a separator theirs' first line would
        // fuse onto it.
        merged.push('\n');
    }
    merged.push_str(&theirs_kept);
    Some(merged)
}

/// The bytes `side` appended after `base`, or `None` when `side` is not a
/// pure append. Byte-prefix alone is not enough: `"abc"` → `"abcdef"` keeps
/// the base as a prefix but rewrites its final line, so a non-empty suffix
/// must start at a line boundary — either the base ended with a newline or
/// the suffix begins with one.
fn appended_suffix<'side>(base: &str, side: &'side str) -> Option<&'side str> {
    let suffix = side.strip_prefix(base)?;
    if suffix.is_empty() || base.is_empty() || base.ends_with('\n') || starts_on_new_line(suffix) {
        Some(suffix)
    } else {
        None
    }
}

fn starts_on_new_line(text: &str) -> bool {
    text.starts_with('\n') || text.starts_with("\r\n")
}

fn starts_with_frontmatter(source: &str) -> bool {
    source.starts_with("---\n") || source.starts_with("---\r\n")
}

/// Strip a line's terminator and any trailing `\r`, the capture drain's
/// comparison key (a CRLF daily dedupes like an LF one).
fn line_key(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

/// Drop theirs-suffix lines whose exact content already appears in ours'
/// suffix. Only lines with content participate — blank lines are structure,
/// not entries. Returns `None` when nothing with content remains (identical
/// appends collapse to one copy).
fn dedup_against(theirs: &str, ours: &str) -> Option<String> {
    let ours_lines: HashSet<&str> = ours
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut kept = String::with_capacity(theirs.len());
    let mut has_content = false;
    for line in theirs.split_inclusive('\n') {
        let key = line_key(line);
        let blank = key.trim().is_empty();
        if !blank && ours_lines.contains(key) {
            continue;
        }
        if !blank {
            has_content = true;
        }
        kept.push_str(line);
    }
    has_content.then_some(kept)
}

#[cfg(test)]
mod tests {
    use super::{is_daily_note_path, merge_appends};

    #[test]
    fn recognizes_daily_note_paths() {
        assert!(is_daily_note_path("daily/2026-07-02.md"));
        assert!(!is_daily_note_path("daily/2026-7-2.md"));
        assert!(!is_daily_note_path("daily/2026-07-02.txt"));
        assert!(!is_daily_note_path("notes/2026-07-02.md"));
        assert!(!is_daily_note_path("daily/nested/2026-07-02.md"));
        assert!(!is_daily_note_path("daily/someday.md"));
    }

    #[test]
    fn merges_disjoint_appends_ours_first() {
        let base = "# Daily\n\n- morning note\n";
        let ours = "# Daily\n\n- morning note\n- from the mac\n";
        let theirs = "# Daily\n\n- morning note\n- from the phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("# Daily\n\n- morning note\n- from the mac\n- from the phone\n"),
        );
    }

    #[test]
    fn identical_appends_collapse_to_one_copy() {
        let base = "- existing\n";
        let ours = "- existing\n- same capture\n";
        assert_eq!(
            merge_appends(base, ours, ours).as_deref(),
            Some("- existing\n- same capture\n"),
        );
    }

    #[test]
    fn shared_capture_lines_are_not_doubled() {
        let base = "- existing\n";
        let ours = "- existing\n- same capture\n- only on mac\n";
        let theirs = "- existing\n- same capture\n- only on phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- existing\n- same capture\n- only on mac\n- only on phone\n"),
        );
    }

    #[test]
    fn crlf_lines_dedupe_against_lf_ones() {
        let base = "- existing\n";
        let ours = "- existing\n- same capture\n";
        let theirs = "- existing\n- same capture\r\n- only on phone\r\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- existing\n- same capture\n- only on phone\r\n"),
        );
    }

    #[test]
    fn duplicates_of_base_lines_are_kept() {
        // The drain never appends a line already in the note, so a suffix
        // repeating a base line was typed deliberately — keep it.
        let base = "- existing\n";
        let ours = "- existing\n- existing\n";
        let theirs = "- existing\n- from the phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- existing\n- existing\n- from the phone\n"),
        );
    }

    #[test]
    fn edit_inside_the_base_region_is_not_an_append() {
        let base = "# Daily\n\n- original\n";
        let edited = "# Daily\n\n- rewritten\n- extra\n";
        let appended = "# Daily\n\n- original\n- extra\n";
        assert_eq!(merge_appends(base, edited, appended), None);
        assert_eq!(merge_appends(base, appended, edited), None);
    }

    #[test]
    fn extending_the_base_final_line_is_not_an_append() {
        // Byte-prefix holds but the last line changed ("- note" → "- note and
        // more") — that is an edit, not an append.
        let base = "- note";
        let extended = "- note and more\n";
        let appended = "- note\n- new line\n";
        assert_eq!(merge_appends(base, extended, appended), None);
        assert_eq!(
            merge_appends(base, appended, "- note\n- other\n").as_deref(),
            Some("- note\n- new line\n- other\n"),
        );
    }

    #[test]
    fn frontmatter_change_breaks_the_prefix_and_parks() {
        let base = "---\npinned: false\n---\n\n- note\n";
        let frontmatter_touched = "---\npinned: true\n---\n\n- note\n- extra\n";
        let appended = "---\npinned: false\n---\n\n- note\n- extra\n";
        assert_eq!(merge_appends(base, frontmatter_touched, appended), None);
        assert_eq!(merge_appends(base, appended, frontmatter_touched), None);
    }

    #[test]
    fn unchanged_frontmatter_inside_the_base_merges() {
        let base = "---\npinned: true\n---\n\n- note\n";
        let ours = "---\npinned: true\n---\n\n- note\n- from mac\n";
        let theirs = "---\npinned: true\n---\n\n- note\n- from phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("---\npinned: true\n---\n\n- note\n- from mac\n- from phone\n"),
        );
    }

    #[test]
    fn empty_base_concatenates_both_creations() {
        assert_eq!(
            merge_appends("", "- from mac\n", "- from phone\n").as_deref(),
            Some("- from mac\n- from phone\n"),
        );
    }

    #[test]
    fn empty_base_with_frontmatter_on_either_side_parks() {
        let with_frontmatter = "---\npinned: true\n---\n\n- note\n";
        assert_eq!(merge_appends("", with_frontmatter, "- plain\n"), None);
        assert_eq!(merge_appends("", "- plain\n", with_frontmatter), None);
    }

    #[test]
    fn unterminated_base_accepts_newline_led_suffixes() {
        let base = "- note";
        let ours = "- note\n- from mac\n";
        let theirs = "- note\n- from phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- note\n- from mac\n- from phone\n"),
        );
    }

    #[test]
    fn unterminated_ours_suffix_gets_a_separator_before_theirs() {
        let base = "- note\n";
        let ours = "- note\n- from mac";
        let theirs = "- note\n- from phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- note\n- from mac\n- from phone\n"),
        );
    }

    #[test]
    fn one_side_identical_to_base_yields_the_other() {
        let base = "- note\n";
        let theirs = "- note\n- from phone\n";
        assert_eq!(merge_appends(base, base, theirs).as_deref(), Some(theirs));
        assert_eq!(merge_appends(base, theirs, base).as_deref(), Some(theirs));
    }

    #[test]
    fn whitespace_only_lines_are_never_deduped() {
        let base = "- note\n";
        let ours = "- note\n\n- from mac\n";
        let theirs = "- note\n\n- from phone\n";
        assert_eq!(
            merge_appends(base, ours, theirs).as_deref(),
            Some("- note\n\n- from mac\n\n- from phone\n"),
        );
    }
}
