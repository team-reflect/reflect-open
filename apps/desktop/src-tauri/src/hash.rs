use sha2::{Digest, Sha256};

/// Lowercase hex sha256 (the same encoding as the CLI's `hash.rs`).
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
