//! Content hashing — the Rust mirror of `packages/core/src/indexing/hash.ts`.
//! The index's `notes.file_hash` is the lowercase-hex SHA-256 of the file's
//! text; staleness detection must reproduce it byte-for-byte.

use sha2::{Digest, Sha256};
use std::fmt::Write;

/// Lowercase hex SHA-256 of `content` (UTF-8 bytes, matching Web Crypto over
/// `TextEncoder` output in the TS indexer).
pub fn hash_content(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing to a String cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::hash_content;

    /// Parity with `hashContent` (`hash.ts`): same algorithm, same encoding.
    /// The "hello" vector is the canonical SHA-256 test value.
    #[test]
    fn matches_the_ts_indexer_hash() {
        assert_eq!(
            hash_content("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_ne!(hash_content("hello"), hash_content("hello!"));
    }
}
