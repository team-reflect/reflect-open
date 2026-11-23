use crate::hash::sha256_hex;

/// Note text uses `\n` line endings in memory: `\r\n` and a lone `\r` both
/// become `\n`.
pub fn normalize_line_endings(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The revision hash of a note: [`sha256_hex`] of its text with `\n` line
/// endings. `sha256Hex` in `packages/utils` gives the same value for the same
/// text.
pub fn note_hash(text: &str) -> String {
    if text.contains('\r') {
        sha256_hex(normalize_line_endings(text.to_string()).as_bytes())
    } else {
        sha256_hex(text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_line_endings, note_hash};
    use crate::hash::sha256_hex;

    #[test]
    fn line_endings_normalize_to_lf() {
        assert_eq!(normalize_line_endings("a\nb\n".to_string()), "a\nb\n");
        assert_eq!(normalize_line_endings("a\r\nb\r\n".to_string()), "a\nb\n");
        assert_eq!(normalize_line_endings("a\rb".to_string()), "a\nb");
        assert_eq!(normalize_line_endings("a\r\r\nb".to_string()), "a\n\nb");
    }

    #[test]
    fn note_hash_reads_every_line_ending_as_a_newline() {
        assert_eq!(note_hash("a\r\nb\rc\n"), sha256_hex(b"a\nb\nc\n"));
    }
}
