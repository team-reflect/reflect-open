//! The wire message and capture envelope, mirroring the zod schemas in
//! `@reflect/core` (`actions/capture-envelope.ts` — the source of truth).
//! Serde tolerates unknown fields (a newer extension must not break an older
//! host); the checks here are the ones the host *must* enforce before the
//! envelope id names files on disk.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::HostError;

/// The capture envelope as spooled. `screenshot_ref` is host-stamped — the
/// extension never sends it (the TS wire schema omits it).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub version: u32,
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_text: Option<String>,
    /// In-page meta description; only the iOS share extension sets it, so a
    /// Chrome wire message carrying one passes through untouched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_ref: Option<String>,
    pub captured_at: String,
    pub source: String,
    /// The captured post block (Plan 25), mirroring `capturedPostSchema`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<Post>,
}

/// A captured post — `capturedPostSchema` in the TS source of truth. Only
/// `provider`, `id`, and `trigger` are required; the rest is what the page
/// could read.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub provider: String,
    pub id: String,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<PostAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<PostMedia>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted: Option<QuotedPost>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAuthor {
    pub name: String,
    pub handle: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMedia {
    pub kind: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotedPost {
    pub id: String,
    pub url: String,
    pub author: PostAuthor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<String>,
}

/// zod's `.max(n)` counts UTF-16 code units (`String.prototype.length`), so
/// the host counts the same way to stay at least as strict.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

const POST_TEXT_MAX_LENGTH: usize = 10_000;
const POST_MEDIA_MAX: usize = 4;

fn is_post_id(candidate: &str) -> bool {
    !candidate.is_empty() && candidate.len() <= 40 && candidate.chars().all(|c| c.is_ascii_digit())
}

fn is_post_handle(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= 50
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_http_url(candidate: &str) -> bool {
    candidate.starts_with("https://") || candidate.starts_with("http://")
}

fn validate_author(author: &PostAuthor) -> Result<(), HostError> {
    let name = author.name.trim();
    if name.is_empty() || utf16_len(name) > 200 {
        return Err(HostError::InvalidPayload(
            "post author name must be 1–200 characters".to_string(),
        ));
    }
    if !is_post_handle(&author.handle) {
        return Err(HostError::InvalidPayload(format!(
            "post author handle is malformed: {:?}",
            author.handle
        )));
    }
    Ok(())
}

fn validate_optional_text(text: Option<&String>, what: &str) -> Result<(), HostError> {
    if text.is_some_and(|value| utf16_len(value) > POST_TEXT_MAX_LENGTH) {
        return Err(HostError::InvalidPayload(format!(
            "{what} exceeds {POST_TEXT_MAX_LENGTH} characters"
        )));
    }
    Ok(())
}

fn validate_optional_datetime(value: Option<&String>, what: &str) -> Result<(), HostError> {
    if value.is_some_and(|candidate| !is_iso_datetime(candidate)) {
        return Err(HostError::InvalidPayload(format!(
            "{what} is not an ISO-8601 timestamp"
        )));
    }
    Ok(())
}

/// The post-block checks mirroring `capturedPostSchema`. The shared fixtures
/// pin every rule here against the zod side.
fn validate_post(post: &Post) -> Result<(), HostError> {
    if post.provider != "x" {
        return Err(HostError::InvalidPayload(format!(
            "unknown post provider {:?}",
            post.provider
        )));
    }
    if !is_post_id(&post.id) {
        return Err(HostError::InvalidPayload(format!(
            "post id is not a post id: {:?}",
            post.id
        )));
    }
    if !matches!(post.trigger.as_str(), "bookmark" | "like" | "manual") {
        return Err(HostError::InvalidPayload(format!(
            "unknown post trigger {:?}",
            post.trigger
        )));
    }
    if let Some(author) = &post.author {
        validate_author(author)?;
    }
    validate_optional_text(post.text.as_ref(), "post text")?;
    validate_optional_datetime(post.posted_at.as_ref(), "post postedAt")?;
    if let Some(media) = &post.media {
        if media.len() > POST_MEDIA_MAX {
            return Err(HostError::InvalidPayload(format!(
                "post carries more than {POST_MEDIA_MAX} media"
            )));
        }
        for item in media {
            if !matches!(item.kind.as_str(), "image" | "gif" | "video") {
                return Err(HostError::InvalidPayload(format!(
                    "unknown post media kind {:?}",
                    item.kind
                )));
            }
            if !item.url.starts_with("https://") {
                return Err(HostError::InvalidPayload(
                    "post media url must be https".to_string(),
                ));
            }
            if item.alt.as_ref().is_some_and(|alt| utf16_len(alt) > 1000) {
                return Err(HostError::InvalidPayload(
                    "post media alt exceeds 1000 characters".to_string(),
                ));
            }
        }
    }
    if let Some(quoted) = &post.quoted {
        if !is_post_id(&quoted.id) {
            return Err(HostError::InvalidPayload(format!(
                "quoted post id is not a post id: {:?}",
                quoted.id
            )));
        }
        if !is_http_url(&quoted.url) {
            return Err(HostError::InvalidPayload(
                "quoted post url must be http(s)".to_string(),
            ));
        }
        validate_author(&quoted.author)?;
        validate_optional_text(quoted.text.as_ref(), "quoted post text")?;
        validate_optional_datetime(quoted.posted_at.as_ref(), "quoted post postedAt")?;
    }
    Ok(())
}

/// The extension→host message: envelope plus optional screenshot bytes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireMessage {
    envelope: Envelope,
    screenshot_base64: Option<String>,
}

/// A wire message that passed every host-side check, screenshot decoded.
pub struct ValidatedCapture {
    pub envelope: Envelope,
    pub screenshot: Option<Vec<u8>>,
}

/// Strict UUID shape (8-4-4-4-12 hex). The id names the spool files, so this
/// doubles as the path-safety guard — no separators, no dots, no traversal.
fn is_uuid(candidate: &str) -> bool {
    let groups: Vec<&str> = candidate.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    groups.len() == lengths.len()
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit())
        })
}

fn digits(candidate: &str, range: std::ops::RangeInclusive<u32>) -> bool {
    !candidate.is_empty()
        && candidate.chars().all(|c| c.is_ascii_digit())
        && candidate
            .parse::<u32>()
            .is_ok_and(|value| range.contains(&value))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`) — what
/// `Date.prototype.toISOString` produces, plus explicit offsets. The host
/// must be **at least as strict** here as the drain's zod schema
/// (`capture-envelope.ts`), or it would spool envelopes the drain can only
/// quarantine; the shared fixtures pin the two together.
fn is_iso_datetime(candidate: &str) -> bool {
    let Some((date, rest)) = candidate.split_once('T') else {
        return false;
    };
    let date_parts: Vec<&str> = date.split('-').collect();
    let [year, month, day] = date_parts.as_slice() else {
        return false;
    };
    if year.len() != 4 || !digits(year, 0..=9999) || month.len() != 2 || !digits(month, 1..=12) {
        return false;
    }
    let year_number: u32 = year.parse().unwrap_or(0);
    let month_number: u32 = month.parse().unwrap_or(0);
    if day.len() != 2 || !digits(day, 1..=days_in_month(year_number, month_number)) {
        return false;
    }

    let (time, zone) = match rest.find(['Z', '+']) {
        Some(at) => rest.split_at(at),
        // A negative offset: the '-' after the seconds (time itself has none).
        None => match rest.rfind('-') {
            Some(at) => rest.split_at(at),
            None => return false,
        },
    };
    let (clock, fraction) = match time.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (time, None),
    };
    let clock_parts: Vec<&str> = clock.split(':').collect();
    let [hours, minutes, seconds] = clock_parts.as_slice() else {
        return false;
    };
    let clock_ok = hours.len() == 2
        && digits(hours, 0..=23)
        && minutes.len() == 2
        && digits(minutes, 0..=59)
        && seconds.len() == 2
        && digits(seconds, 0..=59);
    let fraction_ok =
        fraction.is_none_or(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()));
    let zone_ok = match zone {
        "Z" => true,
        offset => match offset.split_at_checked(1) {
            Some(("+" | "-", hhmm)) => match hhmm.split_once(':') {
                Some((oh, om)) => {
                    oh.len() == 2 && digits(oh, 0..=23) && om.len() == 2 && digits(om, 0..=59)
                }
                None => false,
            },
            _ => false,
        },
    };
    clock_ok && fraction_ok && zone_ok
}

impl ValidatedCapture {
    /// Parse and validate one wire payload. Every rejection is an
    /// `invalid-payload` ack with a reason the extension can surface.
    pub fn parse(payload: &[u8]) -> Result<Self, HostError> {
        let message: WireMessage = serde_json::from_slice(payload)
            .map_err(|error| HostError::InvalidPayload(format!("malformed message: {error}")))?;
        let mut envelope = message.envelope;

        if envelope.version != 1 {
            return Err(HostError::InvalidPayload(format!(
                "unsupported envelope version {}",
                envelope.version
            )));
        }
        if !is_uuid(&envelope.id) {
            return Err(HostError::InvalidPayload("id is not a UUID".to_string()));
        }
        if !envelope.url.starts_with("https://") && !envelope.url.starts_with("http://") {
            return Err(HostError::InvalidPayload("url must be http(s)".to_string()));
        }
        if !is_iso_datetime(&envelope.captured_at) {
            return Err(HostError::InvalidPayload(format!(
                "capturedAt is not an ISO-8601 timestamp: {:?}",
                envelope.captured_at
            )));
        }
        if envelope.source != "extension" {
            return Err(HostError::InvalidPayload(format!(
                "unknown source {:?}",
                envelope.source
            )));
        }
        if let Some(post) = &envelope.post {
            validate_post(post)?;
        }

        let screenshot = match message.screenshot_base64 {
            None => None,
            Some(encoded) if encoded.is_empty() => {
                return Err(HostError::InvalidPayload("screenshot is empty".to_string()));
            }
            Some(encoded) => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|error| {
                        HostError::InvalidPayload(format!("screenshot is not base64: {error}"))
                    })?,
            ),
        };
        envelope.screenshot_ref = screenshot.is_some().then(|| format!("{}.jpg", envelope.id));

        Ok(ValidatedCapture {
            envelope,
            screenshot,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(mutate: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut message = serde_json::json!({
            "envelope": {
                "version": 1,
                "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                "url": "https://example.com",
                "title": "Example",
                "capturedAt": "2026-06-12T15:30:22.845Z",
                "source": "extension",
            },
        });
        mutate(&mut message);
        message.to_string().into_bytes()
    }

    #[test]
    fn accepts_a_minimal_message() {
        let capture = ValidatedCapture::parse(&payload(|_| {})).unwrap();
        assert_eq!(capture.envelope.title, "Example");
        assert_eq!(capture.envelope.screenshot_ref, None);
        assert!(capture.screenshot.is_none());
    }

    #[test]
    fn decodes_the_screenshot_and_stamps_the_ref() {
        let capture = ValidatedCapture::parse(&payload(|message| {
            message["screenshotBase64"] = "aGVsbG8=".into();
        }))
        .unwrap();
        assert_eq!(capture.screenshot.as_deref(), Some(b"hello".as_slice()));
        assert_eq!(
            capture.envelope.screenshot_ref.as_deref(),
            Some("7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg")
        );
    }

    #[test]
    fn tolerates_unknown_fields() {
        let capture = ValidatedCapture::parse(&payload(|message| {
            message["envelope"]["futureField"] = "ignored".into();
        }));
        assert!(capture.is_ok());
    }

    #[test]
    fn rejects_traversal_shaped_ids() {
        for id in [
            "../../../etc/passwd",
            "x".repeat(36).as_str(),
            "7C9E6679-7425-40DE-944B-../7fc1f9",
        ] {
            let result = ValidatedCapture::parse(&payload(|message| {
                message["envelope"]["id"] = id.into();
            }));
            assert!(matches!(result, Err(HostError::InvalidPayload(_))), "{id}");
        }
    }

    #[test]
    fn rejects_bad_fields() {
        let cases = [
            (Some("envelope"), "version", serde_json::json!(2)),
            (
                Some("envelope"),
                "url",
                serde_json::json!("file:///etc/passwd"),
            ),
            (Some("envelope"), "capturedAt", serde_json::json!("")),
            (Some("envelope"), "source", serde_json::json!("ios")),
            (None, "screenshotBase64", serde_json::json!("not base64!!!")),
        ];
        for (parent, key, value) in cases {
            let result = ValidatedCapture::parse(&payload(|message| {
                let target = match parent {
                    Some(field) => &mut message[field],
                    None => message,
                };
                target[key] = value;
            }));
            assert!(matches!(result, Err(HostError::InvalidPayload(_))), "{key}");
        }
    }

    #[test]
    fn post_block_round_trips_through_the_spooled_envelope() {
        let capture = ValidatedCapture::parse(&payload(|message| {
            message["envelope"]["post"] = serde_json::json!({
                "provider": "x",
                "id": "20",
                "trigger": "bookmark",
                "author": { "name": "jack", "handle": "jack" },
                "text": "just setting up my twttr",
                "media": [{ "kind": "image", "url": "https://pbs.twimg.com/media/a.jpg" }],
            });
        }))
        .unwrap();
        let spooled = serde_json::to_value(&capture.envelope).unwrap();
        assert_eq!(spooled["post"]["id"], "20");
        assert_eq!(spooled["post"]["author"]["handle"], "jack");
        assert_eq!(spooled["post"]["media"][0]["kind"], "image");
        assert!(spooled["post"].get("quoted").is_none());
    }

    #[test]
    fn post_text_length_counts_utf16_units_like_zod() {
        // 5 001 astral emoji: 5 001 code points, 10 002 UTF-16 units — zod's
        // `.max(10_000)` rejects it, so the host must too.
        let text = "😀".repeat(5_001);
        let result = ValidatedCapture::parse(&payload(|message| {
            message["envelope"]["post"] = serde_json::json!({
                "provider": "x",
                "id": "20",
                "trigger": "manual",
                "text": text,
            });
        }));
        assert!(matches!(result, Err(HostError::InvalidPayload(_))));
    }

    #[test]
    fn garbage_bytes_are_invalid_payload() {
        assert!(matches!(
            ValidatedCapture::parse(b"\x00\x01garbage"),
            Err(HostError::InvalidPayload(_))
        ));
    }

    #[test]
    fn iso_datetime_accepts_what_to_iso_string_produces() {
        for candidate in [
            "2026-06-12T15:30:22Z",
            "2026-06-12T15:30:22.845Z",
            "2026-06-12T15:30:22.845-07:00",
            "2026-06-12T15:30:22+02:00",
            "2028-02-29T00:00:00Z", // leap day
        ] {
            assert!(is_iso_datetime(candidate), "{candidate}");
        }
    }

    #[test]
    fn iso_datetime_rejects_non_timestamps() {
        for candidate in [
            "",
            "yesterday",
            "2026-06-12",            // date only
            "2026-13-12T15:30:22Z",  // month 13
            "2026-06-31T15:30:22Z",  // June 31st
            "2026-02-29T00:00:00Z",  // not a leap year
            "2026-06-12T24:00:00Z",  // hour 24
            "2026-06-12T15:30:22",   // no zone
            "2026-06-12T15:30:22.Z", // empty fraction
        ] {
            assert!(!is_iso_datetime(candidate), "{candidate}");
        }
    }

    /// The other half lives in `capture-envelope.parity.test.ts` — the same
    /// fixtures through the zod source of truth. Together they pin the
    /// invariant that the host never spools an envelope the drain would
    /// quarantine. Add new cases to the fixtures file, never to one side.
    #[test]
    fn shared_fixtures_pin_the_ts_contract() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/core/src/actions/capture-envelope.fixtures.json"
        )))
        .unwrap();
        for case in fixtures["accepted"].as_array().unwrap() {
            let payload = case["message"].to_string();
            assert!(
                ValidatedCapture::parse(payload.as_bytes()).is_ok(),
                "accepted fixture {} must parse",
                case["name"]
            );
        }
        for case in fixtures["rejected"].as_array().unwrap() {
            let payload = case["message"].to_string();
            assert!(
                matches!(
                    ValidatedCapture::parse(payload.as_bytes()),
                    Err(HostError::InvalidPayload(_))
                ),
                "rejected fixture {} must fail",
                case["name"]
            );
        }
    }
}
