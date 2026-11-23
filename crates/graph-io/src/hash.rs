use sha2::{Digest, Sha256};

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
