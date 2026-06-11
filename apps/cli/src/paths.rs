//! Graph path conventions — the Rust mirror of `packages/core/src/graph/paths.ts`.
//! Dailies live at `daily/YYYY-MM-DD.md`; regular notes under `notes/`; only
//! those two directories hold notes.

pub const DAILY_DIR: &str = "daily";
pub const NOTES_DIR: &str = "notes";

/// Directories scanned for markdown notes (mirrors the desktop's `NOTE_DIRS`).
pub const NOTE_DIRS: [&str; 2] = [DAILY_DIR, NOTES_DIR];

/// Graph-relative path to the daily note for an ISO `YYYY-MM-DD` date.
pub fn daily_path(date: &str) -> String {
    format!("{DAILY_DIR}/{date}.md")
}

/// Is `value` shaped like `YYYY-MM-DD`? Shape only — calendar validity is
/// [`parse_calendar_date`]'s job (mirrors the TS split between `DAILY_PATH_RE`
/// and the calendar check).
fn is_date_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// `value` as a **real** calendar date (`2026-02-31` is rejected, matching the
/// TS resolver — an impossible date must never resolve as a daily).
pub fn parse_calendar_date(value: &str) -> Option<&str> {
    if !is_date_shaped(value) {
        return None;
    }
    value.parse::<jiff::civil::Date>().ok()?;
    Some(value)
}

/// Extract the ISO date from a daily-note path (`daily/YYYY-MM-DD.md`), or
/// `None` if it isn't one. Shape-only, like the TS `dateFromDailyPath`.
pub fn date_from_daily_path(path: &str) -> Option<&str> {
    let date = path.strip_prefix("daily/")?.strip_suffix(".md")?;
    is_date_shaped(date).then_some(date)
}

/// Today's local date as `YYYY-MM-DD` (timezone- and DST-correct via jiff,
/// matching the desktop's date-fns local "today").
pub fn today_date() -> String {
    jiff::Zoned::now().date().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_paths_round_trip() {
        assert_eq!(daily_path("2026-06-11"), "daily/2026-06-11.md");
        assert_eq!(
            date_from_daily_path("daily/2026-06-11.md"),
            Some("2026-06-11")
        );
        assert_eq!(date_from_daily_path("notes/2026-06-11.md"), None);
        assert_eq!(date_from_daily_path("daily/nope.md"), None);
    }

    /// Parity with `paths.ts`/`resolve.ts`: shape-valid but impossible dates
    /// are not dailies.
    #[test]
    fn calendar_validation_rejects_impossible_dates() {
        assert_eq!(parse_calendar_date("2026-06-11"), Some("2026-06-11"));
        assert_eq!(parse_calendar_date("2024-02-29"), Some("2024-02-29"));
        assert_eq!(parse_calendar_date("2026-02-31"), None);
        assert_eq!(parse_calendar_date("2026-13-01"), None);
        assert_eq!(parse_calendar_date("2026-6-1"), None);
        assert_eq!(parse_calendar_date("not-a-date"), None);
    }

    #[test]
    fn today_is_iso_shaped() {
        assert!(parse_calendar_date(&today_date()).is_some());
    }
}
