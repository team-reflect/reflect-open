//! The text side of lexical search: the FTS5 `MATCH` expression and the
//! folded title recall needles. `build_fts_match` builds the expression
//! exactly like `buildFtsMatch` (`packages/core/src/indexing/search-query.ts`),
//! and `title_recall_needles` is the twin of `titleRecallNeedles` there.

use unicode_normalization::char::is_combining_mark;

use super::keys::contains_unsegmented_script;

/// The marker FTS5 writes before a highlighted match.
pub const HIGHLIGHT_START: char = '\u{1}';
/// The marker FTS5 writes after a highlighted match.
pub const HIGHLIGHT_END: char = '\u{2}';

/// Enclosed alphanumerics (`Ⓐ`, `🅰`): general category `So`, which `unicode61`
/// separates on, but which `char::is_alphanumeric` accepts through the
/// `Other_Alphabetic` property. Excluded so this file's token test matches
/// `FTS_TOKEN_CHAR_RE` (`search-query.ts`) codepoint for codepoint.
const LETTERLIKE_SYMBOL_RANGES: [(char, char); 4] = [
    ('\u{24B6}', '\u{24E9}'),
    ('\u{1F130}', '\u{1F149}'),
    ('\u{1F150}', '\u{1F169}'),
    ('\u{1F170}', '\u{1F189}'),
];

/// The `Co` half of `unicode61`'s default `L* N* Co` categories, which
/// `char::is_alphanumeric` does not cover.
fn is_private_use(character: char) -> bool {
    matches!(character, '\u{E000}'..='\u{F8FF}' | '\u{F0000}'..='\u{FFFFD}' | '\u{100000}'..='\u{10FFFD}')
}

/// A character `unicode61` keeps inside a token, i.e. its default `categories`
/// of `'L* N* Co'`. The twin of `FTS_TOKEN_CHAR_RE` (`search-query.ts`): both
/// sides must classify every codepoint alike, since the parity corpus compares
/// their expressions byte for byte.
fn is_fts_token_char(character: char) -> bool {
    if is_private_use(character) {
        return true;
    }
    character.is_alphanumeric()
        && !is_combining_mark(character)
        && !LETTERLIKE_SYMBOL_RANGES
            .iter()
            .any(|(first, last)| character >= *first && character <= *last)
}

/// Whether `unicode61` finds any token in a term, i.e. whether FTS can see it.
fn is_tokenizable(term: &str) -> bool {
    term.chars().any(is_fts_token_char)
}

/// Wrap a term as an FTS5 string literal, doubling quotes (FTS5's own escape).
fn quote_fts_literal(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// Whether JavaScript's `\\s` matches `character`. The twin splits terms
/// with it, and it differs from Unicode `White_Space` in two codepoints:
/// U+FEFF is whitespace only here, U+0085 only there.
fn is_js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{FEFF}'
}

/// The terms a search constrains on, the twin of `searchTerms`
/// (`search-query.ts`): a term of pure punctuation tokenizes to an empty
/// phrase, which as an operand of the explicit `AND` matches no rows and would
/// take the whole query with it, so it constrains neither the FTS expression
/// nor title recall. When no term survives, the originals are kept: the query
/// is punctuation only, and title recall can still match it literally.
fn search_terms(query: &str) -> Vec<&str> {
    let terms: Vec<&str> = query
        .split(is_js_whitespace)
        .filter(|term| !term.is_empty())
        .collect();
    let tokenizable: Vec<&str> = terms
        .iter()
        .copied()
        .filter(|term| is_tokenizable(term))
        .collect();
    if tokenizable.is_empty() {
        terms
    } else {
        tokenizable
    }
}

/// Build an FTS5 `MATCH` expression from a free-text query, or `None` when
/// there is nothing to search. Every whitespace-split term is double-quoted
/// (embedded quotes doubled), then matched as a prefix in the title or body
/// column. User operators like `AND`/`*` therefore cannot change the query's
/// meaning or raise syntax errors.
///
/// A punctuation-only query has no tokenizable term to constrain on, so it
/// gets the quoted join: a valid, matchless expression that still lets title
/// recall admit rows.
pub fn build_fts_match(query: &str) -> Option<String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return None;
    }
    if !terms.iter().any(|term| is_tokenizable(term)) {
        return Some(
            terms
                .into_iter()
                .map(quote_fts_literal)
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    Some(
        terms
            .into_iter()
            .map(|term| {
                let literal = quote_fts_literal(term);
                format!("(title : {literal}* OR body : {literal}*)")
            })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// Build an FTS5 `MATCH` expression for titles that contain `text` as a
/// phrase whose last word may be a prefix. The tokenizer drops diacritics, so
/// `elisk` matches `Eliška`. `None` unless that last word has two or more
/// letters or digits: a one-letter prefix expands to most of the vocabulary
/// of the index, which is slow on every keystroke. Every combining mark
/// splits a word here, which can only shorten it, so this errs towards
/// skipping the index.
pub fn build_fts_title_prefix_match(text: &str) -> Option<String> {
    let last_token = text
        .split(|character| !is_fts_token_char(character))
        .rfind(|token| !token.is_empty())?;
    (last_token.chars().count() > 1).then(|| format!("title : {}*", quote_fts_literal(text)))
}

/// The `instr` needles for title recall, one per folded query term — the twin
/// of `titleRecallNeedles` (`search-query.ts`). Matched against
/// `' ' || notes.title_key`: terms in space-delimited scripts carry a leading
/// space so they only match at word starts (`car` finds `Car log`, not
/// `Oscar party`), while unsegmented-script terms match anywhere. Built from
/// the same [`search_terms`] the FTS expression uses, so a term FTS ignores
/// cannot go on constraining recall.
pub fn title_recall_needles(title_key: &str) -> Vec<String> {
    search_terms(title_key)
        .into_iter()
        .map(|term| {
            if contains_unsegmented_script(term) {
                term.to_owned()
            } else {
                format!(" {term}")
            }
        })
        .collect()
}

/// The palette search's bm25 column weights (`filtered-search.ts`): path
/// unranked, title boosted 10× over body. Must stay in lockstep.
pub const RANK_WEIGHTS: [f64; 3] = [0.0, 10.0, 1.0];

#[cfg(test)]
mod tests {
    use super::{build_fts_match, build_fts_title_prefix_match, title_recall_needles};

    /// Parity with `titleRecallNeedles` (`search-query.ts`): space-delimited
    /// terms anchor at word starts (leading space); unsegmented-script terms
    /// match anywhere (no anchor).
    #[test]
    fn needles_match_the_ts_builder() {
        assert_eq!(title_recall_needles("tokyo 東京"), vec![" tokyo", "東京"]);
        assert_eq!(title_recall_needles("car"), vec![" car"]);
        assert_eq!(title_recall_needles(""), Vec::<String>::new());
    }

    /// Parity with `buildFtsMatch` (`search-query.test.ts`) — same inputs,
    /// same expressions, byte for byte.
    #[test]
    fn match_expressions_match_the_ts_builder() {
        assert_eq!(build_fts_match(""), None);
        assert_eq!(build_fts_match("   \t \n "), None);
        assert_eq!(
            build_fts_match("hello"),
            Some("(title : \"hello\"* OR body : \"hello\"*)".to_string())
        );
        assert_eq!(
            build_fts_match("cats AND (dogs*)"),
            Some(
                "(title : \"cats\"* OR body : \"cats\"*) AND (title : \"AND\"* OR body : \"AND\"*) AND (title : \"(dogs*)\"* OR body : \"(dogs*)\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("say \"hi\""),
            Some(
                "(title : \"say\"* OR body : \"say\"*) AND (title : \"\"\"hi\"\"\"* OR body : \"\"\"hi\"\"\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("  alpha   beta "),
            Some(
                "(title : \"alpha\"* OR body : \"alpha\"*) AND (title : \"beta\"* OR body : \"beta\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("meeting - notes"),
            Some(
                "(title : \"meeting\"* OR body : \"meeting\"*) AND (title : \"notes\"* OR body : \"notes\"*)"
                    .to_string()
            )
        );
        assert_eq!(
            build_fts_match("東京 ・"),
            Some("(title : \"東京\"* OR body : \"東京\"*)".to_string())
        );
        assert_eq!(build_fts_match("-"), Some("\"-\"".to_string()));
        assert_eq!(build_fts_match(". -"), Some("\".\" \"-\"".to_string()));
    }

    /// The token test follows unicode61's `L* N* Co` categories, not Rust's
    /// `Alphabetic` property: private use constrains, while combining marks
    /// and enclosed alphanumerics (both `Alphabetic`) do not.
    #[test]
    fn token_classification_matches_the_tokenizer_categories() {
        assert_eq!(
            build_fts_match("\u{F8FF}"),
            Some("(title : \"\u{F8FF}\"* OR body : \"\u{F8FF}\"*)".to_string())
        );
        assert_eq!(
            build_fts_match("hello \u{345}"),
            Some("(title : \"hello\"* OR body : \"hello\"*)".to_string())
        );
        assert_eq!(
            build_fts_match("hello \u{24B6}"),
            Some("(title : \"hello\"* OR body : \"hello\"*)".to_string())
        );
    }

    /// Title recall drops the same terms the FTS expression drops, so a
    /// punctuation term cannot go on constraining recall.
    #[test]
    fn needles_drop_terms_the_fts_expression_ignores() {
        assert_eq!(title_recall_needles("tokyo -"), vec![" tokyo"]);
        // Punctuation only: recall still matches it literally.
        assert_eq!(title_recall_needles("-"), vec![" -"]);
    }

    #[test]
    fn terms_split_on_javascript_whitespace() {
        assert_eq!(build_fts_match("\u{FEFF}"), None);
        assert_eq!(
            build_fts_match("a\u{FEFF}b").as_deref(),
            Some("(title : \"a\"* OR body : \"a\"*) AND (title : \"b\"* OR body : \"b\"*)")
        );
        assert_eq!(title_recall_needles("a\u{85}b"), vec![" a\u{85}b"]);
    }

    #[test]
    fn title_prefix_match_needs_a_last_word_of_two_letters() {
        let phrase = |text: &str| build_fts_title_prefix_match(text);
        assert_eq!(
            phrase("eliska nov").as_deref(),
            Some("title : \"eliska nov\"*")
        );
        assert_eq!(phrase("ab\"cd").as_deref(), Some("title : \"ab\"\"cd\"*"));
        // Every combining mark splits a token here, even those `unicode61` keeps.
        for text in [
            "",
            "e",
            "c++",
            "ab c",
            "i\u{307}s",
            "the\u{336}b",
            "राम",
            "𝐀",
        ] {
            assert_eq!(phrase(text), None, "{text}");
        }
        assert_eq!(
            phrase("i\u{307}st").as_deref(),
            Some("title : \"i\u{307}st\"*")
        );
    }
}
