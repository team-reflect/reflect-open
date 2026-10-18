//! X's syndication API: the public JSON behind embedded posts.

use super::x_archive_store::valid_id;
use crate::error::{AppError, AppResult};
use crate::web_fetch::{classify_fetch_error, classify_fetch_status, USER_AGENT};
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const ENDPOINT: &str = "https://cdn.syndication.twimg.com/tweet-result";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BYTES: usize = 1024 * 1024;

// https://github.com/vercel/react-tweet/blob/react-tweet%403.3.1/packages/react-tweet/src/api/fetch-tweet.ts#L48-L66
const FEATURES: &str = "tfw_timeline_list:;\
tfw_follower_count_sunset:true;\
tfw_tweet_edit_backend:on;\
tfw_refsrc_session:on;\
tfw_fosnr_soft_interventions_enabled:on;\
tfw_show_birdwatch_pivots_enabled:on;\
tfw_show_business_verified_badge:on;\
tfw_duplicate_scribes_to_settings:on;\
tfw_use_profile_image_shape_enabled:on;\
tfw_show_blue_verified_badge:on;\
tfw_legacy_timeline_sunset:true;\
tfw_show_gov_verified_badge:on;\
tfw_show_business_affiliate_badge:on;\
tfw_tweet_edit_frontend:on";

const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// JavaScript's `Number.prototype.toString(36)` for a positive number below
/// 2^53, digit for digit as V8 prints it.
fn to_base36(value: f64) -> String {
    let mut integer = value.floor();
    let mut fraction = value - integer;
    let next = f64::from_bits(value.to_bits() + 1);
    let mut delta = (0.5 * (next - value)).max(f64::from_bits(1));
    let mut fraction_digits: Vec<u8> = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= 36.0;
            delta *= 36.0;
            let digit = fraction as u8;
            fraction_digits.push(digit);
            fraction -= f64::from(digit);
            let round_up = fraction > 0.5 || (fraction == 0.5 && digit & 1 == 1);
            if round_up && fraction + delta > 1.0 {
                // Carry into the previous digits, dropping those that overflow.
                loop {
                    match fraction_digits.pop() {
                        None => {
                            integer += 1.0;
                            break;
                        }
                        Some(last) if last + 1 < 36 => {
                            fraction_digits.push(last + 1);
                            break;
                        }
                        Some(_) => {}
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }
    let mut integer_digits: Vec<u8> = Vec::new();
    loop {
        let remainder = integer % 36.0;
        integer_digits.push(remainder as u8);
        integer = (integer - remainder) / 36.0;
        if integer <= 0.0 {
            break;
        }
    }
    let mut text: String = integer_digits
        .iter()
        .rev()
        .map(|&digit| DIGITS[digit as usize] as char)
        .collect();
    if !fraction_digits.is_empty() {
        text.push('.');
        text.extend(
            fraction_digits
                .iter()
                .map(|&digit| DIGITS[digit as usize] as char),
        );
    }
    text
}

/// The `token` query parameter, which is derived from the post id.
// https://github.com/vercel/react-tweet/blob/react-tweet%403.3.1/packages/react-tweet/src/api/fetch-tweet.ts#L27-L31
fn token(post_id: &str) -> AppResult<String> {
    let id: f64 = post_id
        .parse()
        .map_err(|_| AppError::parse("invalid-post-id"))?;
    Ok(to_base36(id / 1e15 * std::f64::consts::PI)
        .chars()
        .filter(|&character| character != '0' && character != '.')
        .collect())
}

fn client() -> AppResult<reqwest::Client> {
    static CLIENT: OnceLock<AppResult<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                // The endpoint answers 400 to a request without a user agent.
                .user_agent(USER_AGENT)
                .build()
                .map_err(classify_fetch_error)
        })
        .clone()
}

/// A deleted post answers `{}` and a private one answers a tombstone.
// https://github.com/vercel/react-tweet/blob/react-tweet%403.3.1/packages/react-tweet/src/api/fetch-tweet.ts#L73-L84
fn is_missing(post: &Value) -> bool {
    post.as_object().is_some_and(|object| object.is_empty())
        || post.get("__typename").and_then(Value::as_str) == Some("TweetTombstone")
}

/// The syndication JSON of one post, or `None` when X has no public post
/// with this id.
#[tauri::command]
pub async fn x_syndication_fetch(post_id: String) -> AppResult<Option<Value>> {
    if !valid_id(&post_id) {
        return Err(AppError::parse("invalid-post-id"));
    }
    let token = token(&post_id)?;
    let mut response = client()?
        .get(ENDPOINT)
        .query(&[
            ("id", post_id.as_str()),
            ("lang", "en"),
            ("features", FEATURES),
            ("token", token.as_str()),
        ])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(classify_fetch_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if let Some(error) = classify_fetch_status(ENDPOINT, response.status()) {
        return Err(error);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(AppError::parse("X post answer is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    let post: Value =
        serde_json::from_slice(&body).map_err(|error| AppError::parse(error.to_string()))?;
    Ok(if is_missing(&post) { None } else { Some(post) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected values come from react-tweet's `getToken` run in Node.js 24.
    #[test]
    fn token_matches_javascript() {
        for (id, expected) in [
            ("1", "bhi2ay3f28n"),
            ("9", "2vdikqiurk6"),
            ("20", "6dq1a2xwd93"),
            ("1577855540407197696", "3toz99oivuy"),
            ("2101821426122596578", "53f2eictsjp"),
        ] {
            assert_eq!(token(id).unwrap(), expected);
        }
    }

    #[test]
    fn deleted_and_private_posts_are_missing() {
        assert!(is_missing(&json!({})));
        assert!(is_missing(&json!({ "__typename": "TweetTombstone" })));
        assert!(!is_missing(
            &json!({ "__typename": "Tweet", "id_str": "20" })
        ));
    }
}
