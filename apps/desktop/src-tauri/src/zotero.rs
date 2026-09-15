//! Zotero integration (desktop): search the local Zotero library through
//! Zotero 7's built-in Local API and return candidate items for the link
//! picker.
//!
//! Zotero runs a read-only HTTP server on `127.0.0.1:23119` when "Allow other
//! applications on this computer to communicate with Zotero" is enabled
//! (Settings → Advanced). No credentials are involved: the server answers
//! anonymous localhost requests that carry the `Zotero-Allowed-Request`
//! header — its guard against browser-originated CSRF/DNS-rebinding requests.
//!
//! Rust owns the capability (fetch + normalize); which item becomes which
//! markdown link is policy in `@reflect/core` (`zotero/commands.ts`).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Zotero's Local API item listing. `users/0` is the "current user" alias
/// Zotero rewrites server-side, so no user id is ever needed.
const ZOTERO_API_ITEMS: &str = "http://127.0.0.1:23119/api/users/0/items";
/// Cap on returned items — the same 50-row ceiling the Obsidian plugin uses.
const ZOTERO_RESULT_LIMIT: usize = 50;
const ZOTERO_TIMEOUT: Duration = Duration::from_secs(5);

/// One searchable library item, normalized for the picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    /// The 8-character Zotero item key — the `zotero://` deep-link target.
    pub key: String,
    pub title: String,
    /// Creator display names in document order ("Smith, John").
    pub creators: Vec<String>,
    /// The item's `date` field as authored ("2020-01-01", "2020", "n.d.").
    pub date: Option<String>,
    pub item_type: String,
    /// The item's abstract as authored; the picker truncates for display.
    pub abstract_note: Option<String>,
    /// The item's URL field, when the item carries one.
    pub url: Option<String>,
}

/// The `data` envelope every Local API item is wrapped in.
#[derive(Debug, Deserialize)]
struct ZoteroApiEnvelope {
    data: ZoteroApiData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoteroApiData {
    key: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    creators: Vec<ZoteroApiCreator>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    item_type: String,
    #[serde(default)]
    abstract_note: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoteroApiCreator {
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    /// The `name` field, set only for institution creators.
    #[serde(default)]
    name: Option<String>,
}

/// The display name for one creator: person creators render "Last, First",
/// institution creators render their `name`. None when the creator has no
/// renderable name at all.
fn render_creator_name(creator: &ZoteroApiCreator) -> Option<String> {
    if let Some(name) = creator.name.as_deref().filter(|name| !name.trim().is_empty()) {
        return Some(name.to_string());
    }
    let first = creator.first_name.as_deref().unwrap_or("").trim();
    let last = creator.last_name.as_deref().unwrap_or("").trim();
    match (first.is_empty(), last.is_empty()) {
        (true, true) => None,
        (true, false) => Some(last.to_string()),
        (false, true) => Some(first.to_string()),
        (false, false) => Some(format!("{last}, {first}")),
    }
}

fn classify_zotero_error(err: reqwest::Error) -> AppError {
    AppError::Network {
        message: format!(
            "Couldn't connect to Zotero — is the app running with its local API enabled? ({err})"
        ),
    }
}

/// Search the local Zotero library by title/creator/year (Zotero's
/// quicksearch). Returns an empty list for an empty query or when nothing
/// matches; fails with a `Network` error when Zotero is closed or its Local
/// API is disabled, and a `parse` error when the response is malformed.
#[tauri::command]
pub async fn zotero_search(query: String) -> AppResult<Vec<ZoteroItem>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(ZOTERO_TIMEOUT)
        .user_agent("Reflect")
        .build()
        .map_err(|err| AppError::io(err.to_string()))?;
    let response = client
        .get(ZOTERO_API_ITEMS)
        .query(&[
            ("itemType", "-attachment"),
            ("q", query),
            ("limit", &ZOTERO_RESULT_LIMIT.to_string()),
        ])
        // Zotero's local server silently drops browser-looking requests unless
        // they prove intent with this header (its CSRF/DNS-rebinding guard).
        .header("Zotero-Allowed-Request", "true")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(classify_zotero_error)?;

    if !response.status().is_success() {
        return Err(AppError::Network {
            message: format!("Zotero answered {}", response.status()),
        });
    }
    let envelopes: Vec<ZoteroApiEnvelope> = response
        .json()
        .await
        .map_err(|err| AppError::parse(format!("invalid Zotero response: {err}")))?;

    let items = envelopes
        .into_iter()
        .map(|envelope| {
            let data = envelope.data;
            ZoteroItem {
                key: data.key,
                title: data.title,
                creators: data
                    .creators
                    .iter()
                    .filter_map(render_creator_name)
                    .collect(),
                date: data.date,
                item_type: data.item_type,
                abstract_note: data.abstract_note,
                url: data.url,
            }
        })
        .collect();
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::render_creator_name;
    use super::ZoteroApiCreator;

    fn creator(last_name: &str, first_name: &str) -> ZoteroApiCreator {
        ZoteroApiCreator {
            first_name: Some(first_name.into()),
            last_name: Some(last_name.into()),
            name: None,
        }
    }

    #[test]
    fn renders_person_creators_as_last_comma_first() {
        let creator = creator("Smith", "John");
        assert_eq!(render_creator_name(&creator).as_deref(), Some("Smith, John"));
    }

    #[test]
    fn renders_single_name_creators() {
        let only_last = creator("Smith", "");
        assert_eq!(render_creator_name(&only_last).as_deref(), Some("Smith"));
        let only_first = creator("", "John");
        assert_eq!(render_creator_name(&only_first).as_deref(), Some("John"));
    }

    #[test]
    fn renders_institution_creators_by_name() {
        let institution = ZoteroApiCreator {
            first_name: None,
            last_name: None,
            name: Some("World Health Organization".into()),
        };
        assert_eq!(
            render_creator_name(&institution).as_deref(),
            Some("World Health Organization")
        );
    }

    #[test]
    fn skips_creators_without_a_name() {
        let empty = ZoteroApiCreator {
            first_name: None,
            last_name: None,
            name: None,
        };
        assert_eq!(render_creator_name(&empty), None);
    }
}
