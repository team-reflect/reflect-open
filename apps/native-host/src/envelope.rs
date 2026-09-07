//! The wire message and capture envelope, mirroring the zod schemas in
//! `@reflect/core` (`actions/capture-envelope.ts` — the source of truth).
//! Serde tolerates unknown fields (a newer extension must not break an older
//! host); the checks here are the ones the host *must* enforce before the
//! envelope id names files on disk.

use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

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
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub screenshot_ref: Option<String>,
    pub captured_at: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<XCapture>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XCapture {
    trigger: XTrigger,
    day: String,
    post: XPost,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum XTrigger {
    Manual,
    Bookmark,
    Like,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XAuthor {
    name: String,
    handle: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XText {
    value: String,
    complete: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XImage {
    url: String,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    alt: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XQuote {
    id: String,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    author: Option<XAuthor>,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    text: Option<XText>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct XPost {
    id: String,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    author: Option<XAuthor>,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    text: Option<XText>,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    images: Option<Vec<XImage>>,
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    quote: Option<XQuote>,
}

fn optional_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn bounded(value: &str, maximum: usize) -> bool {
    value.encode_utf16().count() <= maximum
}

fn is_post_id(value: &str) -> bool {
    (1..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_author(author: &Option<XAuthor>) -> bool {
    author.as_ref().is_none_or(|author| {
        !author.name.is_empty()
            && !author.handle.is_empty()
            && bounded(&author.name, 200)
            && bounded(&author.handle, 32)
    })
}

fn is_http_url(value: &str) -> bool {
    (value.starts_with("http://") || value.starts_with("https://"))
        && Url::parse(value).is_ok_and(|url| url.host_str().is_some())
}

fn post_url_matches(value: &str, id: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some(
                "x.com"
                    | "www.x.com"
                    | "mobile.x.com"
                    | "twitter.com"
                    | "www.twitter.com"
                    | "mobile.twitter.com"
            )
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let segments: Vec<&str> = path.split('/').collect();
    let (handle, candidate, suffix) = match segments.as_slice() {
        ["", "i", "web", "status", candidate, suffix @ ..] => ("i", *candidate, suffix),
        ["", handle, "status", candidate, suffix @ ..] => (*handle, *candidate, suffix),
        _ => return false,
    };
    let valid_suffix = match suffix {
        [] => true,
        ["photo" | "video", index] => {
            !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    };
    valid_suffix
        && !handle.is_empty()
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && candidate == id
}

fn valid_x_capture(capture: &XCapture, url: &str) -> bool {
    let post = &capture.post;
    is_iso_datetime(&format!("{}T00:00:00Z", capture.day))
        && is_post_id(&post.id)
        && post_url_matches(url, &post.id)
        && valid_author(&post.author)
        && post
            .text
            .as_ref()
            .is_none_or(|text| !text.value.is_empty() && bounded(&text.value, 20_000))
        && post.images.as_ref().is_none_or(|images| {
            images.len() <= 4
                && images.iter().all(|image| {
                    bounded(&image.url, 2048)
                        && is_http_url(&image.url)
                        && image.alt.as_ref().is_none_or(|alt| bounded(alt, 2000))
                })
        })
        && post.quote.as_ref().is_none_or(|quote| {
            is_post_id(&quote.id)
                && valid_author(&quote.author)
                && quote
                    .text
                    .as_ref()
                    .is_none_or(|text| !text.value.is_empty() && bounded(&text.value, 5000))
        })
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
        let value: serde_json::Value = serde_json::from_slice(payload)
            .map_err(|error| HostError::InvalidPayload(format!("malformed message: {error}")))?;
        let raw_envelope = &value["envelope"];
        if raw_envelope["version"] == 1 && raw_envelope.get("x").is_some() {
            return Err(HostError::InvalidPayload("version 1 cannot carry x".into()));
        }
        let message = WireMessage::deserialize(&value)
            .map_err(|error| HostError::InvalidPayload(format!("malformed message: {error}")))?;
        let mut envelope = message.envelope;

        if !matches!(envelope.version, 1 | 2) {
            return Err(HostError::InvalidPayload(format!(
                "unsupported envelope version {}",
                envelope.version
            )));
        }
        if envelope.version == 2 {
            let capture = envelope
                .x
                .as_ref()
                .ok_or_else(|| HostError::InvalidPayload("version 2 requires x".into()))?;
            if !valid_x_capture(capture, &envelope.url) {
                return Err(HostError::InvalidPayload("invalid X capture".into()));
            }
            if raw_envelope.get("contentText").is_some()
                || raw_envelope.get("metaDescription").is_some()
                || ["note", "selection"].iter().any(|field| {
                    raw_envelope
                        .get(field)
                        .is_some_and(serde_json::Value::is_null)
                })
                || value
                    .get("screenshotBase64")
                    .is_some_and(serde_json::Value::is_null)
                || (capture.trigger != XTrigger::Manual
                    && (["note", "selection"]
                        .iter()
                        .any(|field| raw_envelope.get(field).is_some())
                        || value.get("screenshotBase64").is_some()))
            {
                return Err(HostError::InvalidPayload(
                    "unexpected X capture fields".into(),
                ));
            }
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
        if envelope.version == 2 {
            let bytes = serde_json::to_vec(&envelope)
                .map_err(|error| HostError::InvalidPayload(error.to_string()))?;
            if bytes.len() > 64 * 1024 {
                return Err(HostError::InvalidPayload(
                    "X envelope exceeds 64 KiB".into(),
                ));
            }
        }

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

    #[test]
    fn x_envelope_cap_counts_utf8_bytes_after_screenshot_stamping() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/core/src/actions/capture-envelope.fixtures.json"
        )))
        .unwrap();
        let fixture = fixtures["accepted"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "X manual snapshot")
            .unwrap();
        for screenshot in [None, Some("aGVsbG8=")] {
            let mut message = fixture["message"].clone();
            message.as_object_mut().unwrap().remove("screenshotBase64");
            if let Some(encoded) = screenshot {
                message["screenshotBase64"] = encoded.into();
            }
            message["envelope"]["title"] = "a".repeat(22_000).into();
            let capture = ValidatedCapture::parse(message.to_string().as_bytes()).unwrap();
            assert_eq!(capture.screenshot.is_some(), screenshot.is_some());
            message["envelope"]["title"] = "界".repeat(22_000).into();
            assert!(matches!(
                ValidatedCapture::parse(message.to_string().as_bytes()),
                Err(HostError::InvalidPayload(_))
            ));
        }
        let mut message = fixture["message"].clone();
        message["envelope"]["title"] = "".into();
        let overhead = serde_json::to_vec(&message["envelope"]).unwrap().len();
        message["envelope"]["title"] = "a".repeat(64 * 1024 - overhead).into();
        message.as_object_mut().unwrap().remove("screenshotBase64");
        assert!(ValidatedCapture::parse(message.to_string().as_bytes()).is_ok());
        message["screenshotBase64"] = "aGVsbG8=".into();
        assert!(matches!(
            ValidatedCapture::parse(message.to_string().as_bytes()),
            Err(HostError::InvalidPayload(_))
        ));
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
            let capture = ValidatedCapture::parse(payload.as_bytes())
                .unwrap_or_else(|error| panic!("accepted fixture {}: {error:?}", case["name"]));
            if let Some(expected) = case["message"]["envelope"].get("x") {
                let spooled = serde_json::to_value(&capture.envelope).unwrap();
                assert_eq!(
                    &spooled["x"], expected,
                    "fixture {} lost X data",
                    case["name"]
                );
            }
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
