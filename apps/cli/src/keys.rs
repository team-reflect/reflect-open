//! Match-key folding and script classification — the Rust mirror of
//! `packages/core/src/markdown/keys.ts` and the script table in
//! `packages/core/src/indexing/search-query.ts`. This must produce the same
//! keys the TS indexer wrote to `notes.title_key` / `aliases.alias_key` and
//! classify query terms the same way the app's search does, or lookups
//! silently miss and CLI/app result orders drift.

/// Trim surrounding whitespace and case-fold `value` to its match key.
pub fn fold_key(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Scripts written without spaces between words (Han, kana, Hangul, Thai, …).
/// FTS5's `unicode61` tokenizer only segments at non-alphanumeric characters,
/// so a title run in these scripts indexes as ONE token and a shorter query
/// can never match it lexically — such terms need anywhere-in-the-title
/// substring recall. Space-delimited scripts must NOT get it: `car` may find
/// `Car log` but never `Oscar party`. Mirrors `UNSEGMENTED_SCRIPT_RANGES`
/// (`packages/core/src/indexing/search-query.ts`); the two must move together.
const UNSEGMENTED_SCRIPT_RANGES: &[(u32, u32)] = &[
    (0x0e00, 0x0eff),   // Thai, Lao
    (0x1000, 0x109f),   // Myanmar
    (0x1100, 0x11ff),   // Hangul Jamo
    (0x1780, 0x17ff),   // Khmer
    (0x3005, 0x3007),   // Japanese iteration marks (々〆〇)
    (0x3040, 0x30ff),   // Hiragana, Katakana
    (0x3130, 0x318f),   // Hangul Compatibility Jamo
    (0x31f0, 0x31ff),   // Katakana Phonetic Extensions
    (0x3400, 0x4dbf),   // CJK Extension A
    (0x4e00, 0x9fff),   // CJK Unified Ideographs
    (0xac00, 0xd7af),   // Hangul Syllables
    (0xf900, 0xfaff),   // CJK Compatibility Ideographs
    (0xff66, 0xff9f),   // Halfwidth Katakana
    (0x20000, 0x2fa1f), // CJK Extensions B–F, Compatibility Supplement
];

/// True when `value` contains a character from an unsegmented script.
pub fn contains_unsegmented_script(value: &str) -> bool {
    value.chars().any(|character| {
        let code_point = character as u32;
        UNSEGMENTED_SCRIPT_RANGES
            .iter()
            .any(|&(start, end)| (start..=end).contains(&code_point))
    })
}

#[cfg(test)]
mod tests {
    use super::{contains_unsegmented_script, fold_key};

    /// Parity with `foldKey` (`keys.ts`): trim + Unicode lowercase. JS
    /// `toLowerCase` and Rust `to_lowercase` agree on all common inputs; known
    /// divergence is limited to locale-specific edge cases (e.g. Turkish
    /// dotless-i), accepted in the Plan 14 contract.
    #[test]
    fn folds_like_the_ts_indexer() {
        assert_eq!(fold_key("  MiXeD Case  "), "mixed case");
        assert_eq!(fold_key("Café"), "café");
        assert_eq!(fold_key("ALPHA"), "alpha");
        assert_eq!(fold_key(""), "");
    }

    /// Parity with `containsUnsegmentedScript` (`search-query.ts`): the same
    /// inputs must classify the same way in the CLI and the app.
    #[test]
    fn classifies_scripts_like_the_ts_search() {
        assert!(contains_unsegmented_script("東京"));
        assert!(contains_unsegmented_script("とうきょう"));
        assert!(contains_unsegmented_script("トウキョウ"));
        assert!(contains_unsegmented_script("人々"));
        assert!(contains_unsegmented_script("서울"));
        assert!(contains_unsegmented_script("กรุงเทพ"));
        assert!(contains_unsegmented_script("𠮷野")); // CJK Extension B
        assert!(contains_unsegmented_script("東京trip")); // mixed runs count
        assert!(!contains_unsegmented_script("tokyo"));
        assert!(!contains_unsegmented_script("café"));
        assert!(!contains_unsegmented_script("Москва"));
        assert!(!contains_unsegmented_script(""));
    }
}
