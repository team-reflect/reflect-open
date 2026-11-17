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

use reflect_index::read::search::{RankedOptions, search_ranked};
use reflect_index::text::fts::{HIGHLIGHT_END, HIGHLIGHT_START};
use reflect_index::text::keys::fold_key;
use reflect_types::SearchRequest;
use rusqlite::Connection;

use crate::error::CliError;

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

/// Ranked search over the notes that are not private, with the ranking of
/// the app's palette search (`reflect_index::read::search`). A hit that only
/// its title matched has an empty snippet, and score `0` when title recall
/// admits it. The caller re-checks each hit's file frontmatter (the index row
/// may lag a just-flagged note).
pub fn search_index(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CliError> {
    let request = SearchRequest {
        text: query.to_owned(),
        title_key: fold_key(query),
        limit: Some(u32::try_from(limit).unwrap_or(u32::MAX)),
        ..SearchRequest::default()
    };
    let options = RankedOptions {
        exclude_private: true,
        snippet_tokens: 12,
    };
    let hits =
        search_ranked(conn, &request, options).map_err(|err| CliError::runtime(err.message()))?;
    Ok(hits
        .into_iter()
        .map(|ranked| {
            // SQLite returns an unmarked body fragment when only the title
            // matched; that is not a search snippet.
            let snippet = match ranked.hit.snippet {
                Some(marked) if marked.contains(HIGHLIGHT_START) => {
                    marked.replace([HIGHLIGHT_START, HIGHLIGHT_END], "")
                }
                _ => String::new(),
            };
            SearchHit {
                path: ranked.hit.path,
                title: ranked.hit.title,
                snippet,
                score: ranked.score,
            }
        })
        .collect())
}
