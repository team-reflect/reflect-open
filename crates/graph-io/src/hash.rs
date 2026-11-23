use sha2::{Digest, Sha256};

// FIXME: it seems that you have two "sha256_hex" in your rust codebase. See also apps/cli/src/hash.rs
// FIXME: is there a crate that can be used to put all these small/sharable utils, just like packages/utils/package.json. Perhaps we can create one and put some of these small utils in there (not only sha256_hex), so that we can share them across the codebase.

/// Lowercase hex sha256 (the same encoding as the CLI's `hash.rs`).
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}


// FIXME: should we put note_hash into a note hash.rs file? Up to you. Just a question.
/// The revision hash of a note: [`sha256_hex`] of its text with `\n` line
/// endings.
pub fn note_hash(text: &str) -> String {
    if text.contains('\r') {
        sha256_hex(reflect_graph_paths::normalize_line_endings(text.to_string()).as_bytes())
    } else {
        sha256_hex(text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::{note_hash, sha256_hex};

    #[test]
    fn note_hash_reads_every_line_ending_as_a_newline() {
        assert_eq!(note_hash("a\r\nb\rc\n"), sha256_hex(b"a\nb\nc\n"));
    }
}
