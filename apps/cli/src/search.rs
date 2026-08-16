//! Lexical search over the FTS index. The `MATCH` expression is built exactly
//! like `buildFtsMatch` (`packages/core/src/indexing/search-query.ts`) and
//! ranking matches the desktop's palette search (`filtered-search.ts`): exact,
//! prefix, and all-terms title matches lead, then title-boosted bm25 with the
//! same column weights, pinned, recency, and `path`. Folded title recall
//! matches each term at a title word start — except terms in unsegmented
//! scripts, which match anywhere: FTS5's `unicode61` tokenizer cannot match
//! part of an uninterrupted CJK title (`titleRecallNeedles` in
//! `search-query.ts` is the TS twin). The CLI adds its privacy filter
//! (`notes.is_private = 0`) and FTS5 `snippet()`.

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};
use unicode_normalization::char::is_combining_mark;

use crate::error::CliError;
use crate::keys::contains_unsegmented_script;

const HIGHLIGHT_START: char = '\u{1}';
const HIGHLIGHT_END: char = '\u{2}';

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

/// The terms a search constrains on, the twin of `searchTerms`
/// (`search-query.ts`): a term of pure punctuation tokenizes to an empty
/// phrase, which as an operand of the explicit `AND` matches no rows and would
/// take the whole query with it, so it constrains neither the FTS expression
/// nor title recall. When no term survives, the originals are kept: the query
/// is punctuation only, and title recall can still match it literally.
fn search_terms(query: &str) -> Vec<&str> {
    let terms: Vec<&str> = query.split_whitespace().collect();
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

/// One search result row.
#[derive(Debug)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// FTS5 `snippet()` over the indexed plain-text body.
    pub snippet: String,
    /// Title-boosted bm25 score (more negative = better); `0` for title-recall hits.
    pub score: f64,
}

/// The `instr` needles for title recall, one per folded query term — the twin
/// of `titleRecallNeedles` (`search-query.ts`). Matched against
/// `' ' || notes.title_key`: terms in space-delimited scripts carry a leading
/// space so they only match at word starts (`car` finds `Car log`, not
/// `Oscar party`), while unsegmented-script terms match anywhere. Built from
/// the same [`search_terms`] the FTS expression uses, so a term FTS ignores
/// cannot go on constraining recall.
fn title_recall_needles(title_key: &str) -> Vec<String> {
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
const RANK_EXPR: &str = "bm25(search_fts, 0, 10.0, 1.0)";

/// Ranked, private-excluded search mirroring the desktop palette ordering
/// (`filtered-search.ts`): exact, prefix, and all-terms title matches first,
/// then title-boosted bm25, pinned and recency tiebreakers, then `path`. A
/// materialized CTE runs MATCH once because SQLite rejects it beneath a plain
/// OR and otherwise flattens a derived FTS join into one scan per note. The
/// LEFT JOIN admits title-recall-only rows. Matches already covered by title
/// recall keep an empty snippet and score `0`, while tokenizer-normalized title
/// matches retain their lexical rank. The caller re-checks each hit's file
/// frontmatter (the index row may lag a just-flagged note).
pub fn search_index(
    conn: &Connection,
    match_expr: &str,
    title_key: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CliError> {
    let needles = title_recall_needles(title_key);
    if needles.is_empty() {
        return Ok(Vec::new());
    }
    let title_term_predicate = needles
        .iter()
        .enumerate()
        .map(|(index, _)| format!("instr(' ' || notes.title_key, ?{}) > 0", index + 3))
        .collect::<Vec<String>>()
        .join(" AND ");
    let limit_parameter = needles.len() + 3;
    let mut statement = conn.prepare(&format!(
        "WITH lexical AS MATERIALIZED (
           SELECT path, snippet(search_fts, 2, char(1), char(2), '…', 12) AS snippet,
                  {RANK_EXPR} AS rank
           FROM search_fts
           WHERE search_fts MATCH ?1
         )
         SELECT notes.path, notes.title, coalesce(lexical.snippet, ''),
                CASE
                  WHEN instr(coalesce(lexical.snippet, ''), char(1)) > 0
                    OR NOT ({title_term_predicate})
                    THEN coalesce(lexical.rank, 0)
                  ELSE 0
                END AS effective_rank
         FROM notes
         LEFT JOIN lexical ON lexical.path = notes.path
         WHERE (lexical.path IS NOT NULL OR ({title_term_predicate}))
           AND notes.is_private = 0 AND notes.kind != 'template'
         ORDER BY CASE
                    WHEN notes.title_key = ?2 THEN 0
                    WHEN instr(notes.title_key, ?2) = 1 THEN 1
                    WHEN {title_term_predicate} THEN 2
                    ELSE 3
                  END,
                  effective_rank,
                  notes.is_pinned DESC,
                  notes.mtime DESC,
                  notes.path ASC
         LIMIT ?{limit_parameter}",
    ))?;
    let mut parameters = vec![
        Value::Text(match_expr.to_owned()),
        Value::Text(title_key.to_owned()),
    ];
    parameters.extend(needles.into_iter().map(Value::Text));
    parameters.push(Value::Integer(limit as i64));
    let rows = statement.query_map(params_from_iter(parameters), |row| {
        let marked_snippet: String = row.get(2)?;
        let has_body_match = marked_snippet.contains(HIGHLIGHT_START);
        let snippet = if has_body_match {
            marked_snippet.replace([HIGHLIGHT_START, HIGHLIGHT_END], "")
        } else {
            String::new()
        };
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet,
            score: row.get(3)?,
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::{build_fts_match, title_recall_needles};

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
}
