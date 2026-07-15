//! Tolerant, read-only frontmatter — the Rust mirror of
//! `packages/core/src/markdown/frontmatter.ts` (split semantics) and
//! `model.ts` (field coercions), restricted to the fields the CLI needs:
//! `id`, `title`, `aliases`, `private`. Broken YAML still degrades to "no
//! frontmatter" for metadata derivation, but its privacy state is reported as
//! uncertain so read surfaces can fail closed. The CLI never writes
//! frontmatter.

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
    /// An opening fence was present but no closing fence could be found.
    pub unterminated: bool,
}

/// Tolerant frontmatter data plus whether privacy could be verified.
pub(crate) struct ParsedFrontmatter {
    pub frontmatter: Frontmatter,
    pub privacy_uncertain: bool,
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
        Some(b'\r') => Some(3 + index + 1),
        _ => None,
    }
}

/// Carve a leading YAML frontmatter block off `source`. Mirrors
/// `splitFrontmatter`: the opening fence must be the first line (after an
/// optional UTF-8 BOM). An unterminated block remains plain body, but is
/// flagged so callers enforcing privacy can fail closed.
pub fn split_frontmatter(source: &str) -> FrontmatterSplit<'_> {
    let no_block = FrontmatterSplit {
        raw: None,
        body: source,
        unterminated: false,
    };
    let frontmatter_source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let Some(open_len) = fence_line_len(frontmatter_source) else {
        return no_block;
    };
    let rest = &frontmatter_source[open_len..];

    // Check each physical line start, accepting LF, CRLF, and legacy lone-CR
    // files. The raw block excludes the line break immediately before the
    // closing fence.
    let mut line_start = 0;
    loop {
        if let Some(close_len) = fence_line_len(&rest[line_start..]) {
            let raw_end = if line_start == 0 {
                0
            } else if rest[..line_start].ends_with("\r\n") {
                line_start - 2
            } else {
                line_start - 1
            };
            return FrontmatterSplit {
                raw: Some(&rest[..raw_end]),
                body: &rest[line_start + close_len..],
                unterminated: false,
            };
        }
        let Some(line_break_at) = rest.as_bytes()[line_start..]
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
            .map(|offset| line_start + offset)
        else {
            break;
        };
        line_start = if rest.as_bytes()[line_break_at] == b'\r'
            && rest.as_bytes().get(line_break_at + 1) == Some(&b'\n')
        {
            line_break_at + 2
        } else {
            line_break_at + 1
        };
    }
    FrontmatterSplit {
        raw: None,
        body: source,
        unterminated: true,
    }
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

/// Parse the YAML from [`split_frontmatter`]. Malformed or non-mapping YAML
/// yields defaults for tolerant metadata derivation and marks privacy as
/// uncertain so content/address surfaces can refuse the note.
pub(crate) fn parse_frontmatter_checked(raw: Option<&str>) -> ParsedFrontmatter {
    let Some(raw) = raw else {
        return ParsedFrontmatter {
            frontmatter: Frontmatter::default(),
            privacy_uncertain: false,
        };
    };
    if raw.trim().is_empty() {
        return ParsedFrontmatter {
            frontmatter: Frontmatter::default(),
            privacy_uncertain: false,
        };
    }
    let Ok(documents) = Yaml::load_from_str(raw) else {
        return ParsedFrontmatter {
            frontmatter: Frontmatter::default(),
            privacy_uncertain: true,
        };
    };
    let Some(document) = documents
        .first()
        .filter(|document| document.as_mapping().is_some())
    else {
        return ParsedFrontmatter {
            frontmatter: Frontmatter::default(),
            privacy_uncertain: true,
        };
    };
    ParsedFrontmatter {
        frontmatter: Frontmatter {
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
        },
        privacy_uncertain: false,
    }
}

/// Tolerant metadata-only parser, matching the TypeScript behavior. Privacy
/// enforcement must use [`parse_frontmatter_checked`] instead.
pub fn parse_frontmatter(raw: Option<&str>) -> Frontmatter {
    parse_frontmatter_checked(raw).frontmatter
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
        assert!(!split.unterminated);
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
        assert!(unterminated.unterminated);
        let empty = split_frontmatter("---\n---\nbody");
        assert_eq!(empty.raw, Some(""));
        assert_eq!(empty.body, "body");
        assert!(!empty.unterminated);
    }

    #[test]
    fn windows_line_endings_split_cleanly() {
        let split = split_frontmatter("---\r\ntitle: Foo\r\n---\r\nbody");
        assert_eq!(split.raw, Some("title: Foo"));
        assert_eq!(split.body, "body");
    }

    #[test]
    fn bom_and_lone_cr_frontmatter_split_cleanly() {
        let bom = split_frontmatter("\u{feff}---\ntitle: Foo\n---\nbody");
        assert_eq!(bom.raw, Some("title: Foo"));
        assert_eq!(bom.body, "body");

        let lone_cr = split_frontmatter("---\rtitle: Foo\r---\rbody");
        assert_eq!(lone_cr.raw, Some("title: Foo"));
        assert_eq!(lone_cr.body, "body");
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

    #[test]
    fn malformed_frontmatter_marks_privacy_as_uncertain() {
        let valid = parse_frontmatter_checked(Some("private: false"));
        assert!(!valid.privacy_uncertain);

        let malformed = parse_frontmatter_checked(Some("[broken yaml"));
        assert_eq!(malformed.frontmatter, Frontmatter::default());
        assert!(malformed.privacy_uncertain);

        let non_mapping = parse_frontmatter_checked(Some("- a list\n- not a map"));
        assert_eq!(non_mapping.frontmatter, Frontmatter::default());
        assert!(non_mapping.privacy_uncertain);
    }
}
