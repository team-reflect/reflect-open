//! Match-key folding — the Rust mirror of `packages/core/src/markdown/keys.ts`.
//! Title/alias matching is insensitive to case and surrounding whitespace; this
//! must produce the same keys the TS indexer wrote to `notes.title_key` /
//! `aliases.alias_key`, or lookups silently miss.

/// Trim surrounding whitespace and case-fold `value` to its match key.
pub fn fold_key(value: &str) -> String {
    value.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::fold_key;

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
}
