//! Names of conflict copies: `<stem> (conflict <UTC stamp> <hash8>).<ext>`.
//!
//! The stamp and the hash come from the copied version, so two devices that
//! copy the same version pick the same name.

/// `secs` since the Unix epoch as `YYYY-MM-DD HH-MM-SS` in UTC. The time uses
/// `-` because `:` is not valid in Windows and iCloud file names.
pub fn utc_stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}-{:02}-{:02}",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// `assets/img.png` becomes `assets/img (conflict <stamp> <hash8>).png`; no
/// extension appends the label. Splits on the basename only, so a dot in a
/// directory name (`assets.v1/x`) does not move the copy out of its
/// directory. `n` above 1 adds a counter after the hash.
pub fn conflict_copy_path(rel: &str, stamp: &str, hash8: &str, n: u32) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((dir, file)) => (Some(dir), file),
        None => (None, rel),
    };
    let label = if n > 1 {
        format!("conflict {stamp} {hash8} {n}")
    } else {
        format!("conflict {stamp} {hash8}")
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({label}).{ext}"),
        _ => format!("{file} ({label})"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

/// The first conflict copy path of `rel` that `taken` does not claim.
pub fn free_conflict_copy_path(
    rel: &str,
    stamp: &str,
    hash8: &str,
    taken: impl Fn(&str) -> bool,
) -> String {
    (1..)
        .map(|n| conflict_copy_path(rel, stamp, hash8, n))
        .find(|path| !taken(path))
        .expect("an unbounded range always yields a free name")
}

/// The conflict copy path of `rel` for a version modified at `time_ms`. The
/// name holds the content hash, so it needs no counter.
#[cfg_attr(not(test), allow(dead_code))]
pub fn copy_path(rel: &str, time_ms: u64, hash8: &str) -> String {
    conflict_copy_path(rel, &utc_stamp((time_ms / 1000) as i64), hash8, 1)
}

#[cfg(test)]
mod path_tests {
    use super::*;

    const STAMP: &str = "2026-10-16 08-05-31";

    #[test]
    fn conflict_copies_stay_in_their_directory() {
        let copy = |rel, n| conflict_copy_path(rel, STAMP, "a1b2c3d4", n);
        assert_eq!(
            copy("assets/img.png", 1),
            "assets/img (conflict 2026-10-16 08-05-31 a1b2c3d4).png"
        );
        assert_eq!(
            copy("assets.v1/img", 1),
            "assets.v1/img (conflict 2026-10-16 08-05-31 a1b2c3d4)"
        );
        assert_eq!(
            copy("assets.v1/img.png", 1),
            "assets.v1/img (conflict 2026-10-16 08-05-31 a1b2c3d4).png"
        );
        assert_eq!(
            copy("topfile.bin", 1),
            "topfile (conflict 2026-10-16 08-05-31 a1b2c3d4).bin"
        );
        assert_eq!(
            copy("noext", 1),
            "noext (conflict 2026-10-16 08-05-31 a1b2c3d4)"
        );
        assert_eq!(
            copy("assets/.hidden", 1),
            "assets/.hidden (conflict 2026-10-16 08-05-31 a1b2c3d4)"
        );
    }

    #[test]
    fn utc_stamp_formats_known_instants() {
        assert_eq!(utc_stamp(0), "1970-01-01 00-00-00");
        assert_eq!(utc_stamp(1_709_210_096), "2024-02-29 12-34-56");
        assert_eq!(utc_stamp(1_792_137_931), "2026-10-16 08-05-31");
    }

    #[test]
    fn copy_name_suffix_counts_up_when_taken() {
        let first = "assets/img (conflict 2026-10-16 08-05-31 a1b2c3d4).png";
        let second = "assets/img (conflict 2026-10-16 08-05-31 a1b2c3d4 2).png";
        assert_eq!(
            free_conflict_copy_path("assets/img.png", STAMP, "a1b2c3d4", |p| p == first),
            second
        );
        assert_eq!(
            free_conflict_copy_path("assets/img.png", STAMP, "a1b2c3d4", |p| p == first
                || p == second),
            "assets/img (conflict 2026-10-16 08-05-31 a1b2c3d4 3).png"
        );
    }

    #[test]
    fn copy_path_has_no_counter() {
        assert_eq!(
            copy_path("a/b.zip", 1_792_137_931_000, "a1b2c3d4"),
            "a/b (conflict 2026-10-16 08-05-31 a1b2c3d4).zip"
        );
    }
}
