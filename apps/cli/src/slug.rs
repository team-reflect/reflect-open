//! Title-derived note filenames, mirroring `packages/core/src/markdown/slug.ts`.

use unicode_normalization::UnicodeNormalization;

const MAX_SLUG_CHARS: usize = 60;

fn is_windows_reserved(value: &str) -> bool {
    matches!(
        value,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

/// Derive a portable, lowercase filename slug from a note title.
pub fn slug_for_title(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.nfc().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else if character.is_whitespace() || matches!(character, '-' | '_') {
            separator = true;
        }
    }
    slug = slug.chars().take(MAX_SLUG_CHARS).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        return "untitled".to_string();
    }
    if is_windows_reserved(&slug) {
        return format!("{slug}-note");
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::slug_for_title;

    #[test]
    fn matches_the_core_slug_examples() {
        assert_eq!(slug_for_title("Meeting Notes"), "meeting-notes");
        assert_eq!(slug_for_title("Don't Panic!"), "dont-panic");
        assert_eq!(slug_for_title("Q3 / Q4 Review"), "q3-q4-review");
        assert_eq!(slug_for_title("path\\with\\slashes"), "pathwithslashes");
        assert_eq!(slug_for_title("日本語ノート"), "日本語ノート");
        assert_eq!(slug_for_title("🎉🎉🎉"), "untitled");
        assert_eq!(slug_for_title("CON"), "con-note");
        assert_eq!(slug_for_title(&"a".repeat(80)), "a".repeat(60));
    }
}
