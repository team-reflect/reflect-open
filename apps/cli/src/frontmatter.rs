//! Tolerant, read-only frontmatter — the Rust mirror of
//! `packages/core/src/markdown/frontmatter.ts` (split semantics) and
//! `model.ts` (field coercions), restricted to the fields the CLI needs:
//! `id`, `title`, `aliases`, `private`. Broken YAML degrades to "no
//! frontmatter", never an unreadable note. The CLI never writes frontmatter.

use saphyr::{LoadableYamlNode, Scalar, Yaml};

/// The CLI's frontmatter subset. `private` follows the TS `coercePrivate`
/// rules exactly — it is the hard privacy block and must never drift.
#[derive(Debug, Default, PartialEq)]
pub struct Frontmatter {
    /// The durable note identity (Plan 17's ULID); string-only, like `title`.
    pub id: Option<String>,
    pub title: Option<String>,
    pub aliases: Vec<String>,
    pub private: bool,
}

/// Result of carving a leading `---` block off the source.
pub struct FrontmatterSplit<'source> {
    /// YAML text between the fences, or `None` when there's no block.
    pub raw: Option<&'source str>,
    /// Everything after the closing fence (the markdown body).
    pub body: &'source str,
}

/// Length of a fence line (`---[ \t]*` then newline-or-EOF) at the start of
/// `text`, or `None` if `text` doesn't begin with one.
fn fence_line_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("---")?;
    let bytes = rest.as_bytes();
    let mut index = 0;
    while index < bytes.len() && (bytes[index] == b' ' || bytes[index] == b'\t') {
        index += 1;
    }
    match bytes.get(index) {
        None => Some(3 + index),
        Some(b'\n') => Some(3 + index + 1),
        Some(b'\r') if bytes.get(index + 1) == Some(&b'\n') => Some(3 + index + 2),
        _ => None,
    }
}

/// Carve a leading YAML frontmatter block off `source`. Mirrors
/// `splitFrontmatter`: the opening fence must be the very first line; an
/// unterminated block is tolerated as plain body.
pub fn split_frontmatter(source: &str) -> FrontmatterSplit<'_> {
    let no_block = FrontmatterSplit {
        raw: None,
        body: source,
    };
    let Some(open_len) = fence_line_len(source) else {
        return no_block;
    };
    let rest = &source[open_len..];

    // Empty frontmatter: the closing fence sits immediately after the opener.
    if let Some(close_len) = fence_line_len(rest) {
        return FrontmatterSplit {
            raw: Some(""),
            body: &rest[close_len..],
        };
    }
    // Otherwise the closing fence starts right after a newline. The raw block
    // excludes that newline (and a preceding `\r`), matching the TS regex.
    let mut search_from = 0;
    while let Some(newline_at) = rest[search_from..].find('\n').map(|at| search_from + at) {
        let line_start = newline_at + 1;
        if let Some(close_len) = fence_line_len(&rest[line_start..]) {
            let raw_end = if newline_at > 0 && rest.as_bytes()[newline_at - 1] == b'\r' {
                newline_at - 1
            } else {
                newline_at
            };
            return FrontmatterSplit {
                raw: Some(&rest[..raw_end]),
                body: &rest[line_start + close_len..],
            };
        }
        search_from = line_start;
    }
    no_block
}

/// The TS `coercePrivate`: explicit truthy boolean/number/string only; the
/// YAML 1.1 words (`yes`/`on`) a 1.2 loader reads as strings are honoured.
/// Anything unrecognized is **not** private.
fn coerce_private(node: &Yaml) -> bool {
    match node {
        Yaml::Value(Scalar::Boolean(flag)) => *flag,
        Yaml::Value(Scalar::Integer(number)) => *number == 1,
        Yaml::Value(Scalar::FloatingPoint(number)) => number.into_inner() == 1.0,
        Yaml::Value(Scalar::String(text)) => {
            matches!(
                text.trim().to_lowercase().as_str(),
                "true" | "yes" | "on" | "1"
            )
        }
        _ => false,
    }
}

/// `aliases` must be a sequence of strings; any other shape (or any non-string
/// element) degrades to no aliases, matching the zod `.catch([])`.
fn coerce_aliases(node: &Yaml) -> Vec<String> {
    let Some(sequence) = node.as_sequence() else {
        return Vec::new();
    };
    let mut aliases = Vec::with_capacity(sequence.len());
    for item in sequence {
        match item.as_str() {
            Some(alias) => aliases.push(alias.to_string()),
            None => return Vec::new(),
        }
    }
    aliases
}

/// Parse the YAML from [`split_frontmatter`]. Never fails: malformed or
/// non-mapping YAML yields defaults, like the TS `parseFrontmatter`.
pub fn parse_frontmatter(raw: Option<&str>) -> Frontmatter {
    let Some(raw) = raw else {
        return Frontmatter::default();
    };
    if raw.trim().is_empty() {
        return Frontmatter::default();
    }
    let Ok(documents) = Yaml::load_from_str(raw) else {
        return Frontmatter::default();
    };
    let Some(document) = documents.first() else {
        return Frontmatter::default();
    };
    Frontmatter {
        // `id` and `title` must be strings (the TS `stringField`); other
        // types are ignored.
        id: document
            .as_mapping_get("id")
            .and_then(|node| node.as_str())
            .map(str::to_string),
        title: document
            .as_mapping_get("title")
            .and_then(|node| node.as_str())
            .map(str::to_string),
        aliases: document
            .as_mapping_get("aliases")
            .map(coerce_aliases)
            .unwrap_or_default(),
        private: document
            .as_mapping_get("private")
            .is_some_and(coerce_private),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> Frontmatter {
        parse_frontmatter(split_frontmatter(source).raw)
    }

    #[test]
    fn id_is_string_only_like_title() {
        let parsed = parse("---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n");
        assert_eq!(parsed.id.as_deref(), Some("01hzy3v9k2m4n6p8q0r2s4t6vw"));

        // The TS `stringField` ignores non-strings; a numeric id is no id.
        assert_eq!(parse("---\nid: 42\n---\n").id, None);
        assert_eq!(parse("---\ntitle: no id here\n---\n").id, None);
    }

    #[test]
    fn splits_a_block_and_preserves_the_body() {
        let split = split_frontmatter("---\ntitle: Foo\n---\nbody text\n");
        assert_eq!(split.raw, Some("title: Foo"));
        assert_eq!(split.body, "body text\n");
    }

    #[test]
    fn no_fence_means_no_frontmatter() {
        let split = split_frontmatter("# Just a note\n---\nnot frontmatter\n");
        assert_eq!(split.raw, None);
        assert!(split.body.starts_with("# Just a note"));
    }

    /// Parity with `splitFrontmatter`: an unterminated fence is body, and an
    /// empty block (`---` directly followed by `---`) is valid.
    #[test]
    fn tolerates_unterminated_and_empty_blocks() {
        let unterminated = split_frontmatter("---\ntitle: Foo\nno closing fence");
        assert_eq!(unterminated.raw, None);
        let empty = split_frontmatter("---\n---\nbody");
        assert_eq!(empty.raw, Some(""));
        assert_eq!(empty.body, "body");
    }

    #[test]
    fn windows_line_endings_split_cleanly() {
        let split = split_frontmatter("---\r\ntitle: Foo\r\n---\r\nbody");
        assert_eq!(split.raw, Some("title: Foo"));
        assert_eq!(split.body, "body");
    }

    /// Parity with `coercePrivate` (`model.ts`): explicit truthy values only.
    #[test]
    fn private_coercion_matches_the_ts_rules() {
        assert!(parse("---\nprivate: true\n---\n").private);
        assert!(parse("---\nprivate: 1\n---\n").private);
        assert!(parse("---\nprivate: \"yes\"\n---\n").private);
        assert!(parse("---\nprivate: on\n---\n").private);
        assert!(!parse("---\nprivate: false\n---\n").private);
        assert!(!parse("---\nprivate: 2\n---\n").private);
        assert!(!parse("---\nprivate: maybe\n---\n").private);
        assert!(!parse("---\nprivate: [true]\n---\n").private);
        assert!(!parse("# no frontmatter\n").private);
    }

    /// Parity with the zod schema: bad aliases degrade to none; bad YAML
    /// degrades to defaults instead of failing the note.
    #[test]
    fn tolerant_parsing_degrades_gracefully() {
        assert_eq!(parse("---\naliases: [a, b]\n---\n").aliases, vec!["a", "b"]);
        assert!(parse("---\naliases: nope\n---\n").aliases.is_empty());
        assert!(parse("---\naliases: [ok, [nested]]\n---\n")
            .aliases
            .is_empty());
        assert_eq!(parse("---\n[broken yaml\n---\n"), Frontmatter::default());
        assert_eq!(
            parse("---\n- a list\n- not a map\n---\n"),
            Frontmatter::default()
        );
        assert_eq!(parse("---\ntitle: 123\n---\n").title, None);
    }
}
