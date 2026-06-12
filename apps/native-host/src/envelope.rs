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
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_ref: Option<String>,
    pub captured_at: String,
    pub source: String,
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
        && groups
            .iter()
            .zip(lengths)
            .all(|(group, length)| group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit()))
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
            return Err(HostError::InvalidPayload(
                "url must be http(s)".to_string(),
            ));
        }
        if envelope.captured_at.is_empty() {
            return Err(HostError::InvalidPayload("capturedAt is empty".to_string()));
        }
        if envelope.source != "extension" {
            return Err(HostError::InvalidPayload(format!(
                "unknown source {:?}",
                envelope.source
            )));
        }

        let screenshot = match message.screenshot_base64 {
            None => None,
            Some(encoded) => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|error| {
                        HostError::InvalidPayload(format!("screenshot is not base64: {error}"))
                    })?,
            ),
        };
        envelope.screenshot_ref = screenshot
            .is_some()
            .then(|| format!("{}.jpg", envelope.id));

        Ok(ValidatedCapture { envelope, screenshot })
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
        for id in ["../../../etc/passwd", "x".repeat(36).as_str(), "7C9E6679-7425-40DE-944B-../7fc1f9"] {
            let result = ValidatedCapture::parse(&payload(|message| {
                message["envelope"]["id"] = id.into();
            }));
            assert!(matches!(result, Err(HostError::InvalidPayload(_))), "{id}");
        }
    }

    #[test]
    fn rejects_bad_fields() {
        let cases: Vec<Box<dyn FnOnce(&mut serde_json::Value)>> = vec![
            Box::new(|m| m["envelope"]["version"] = 2.into()),
            Box::new(|m| m["envelope"]["url"] = "file:///etc/passwd".into()),
            Box::new(|m| m["envelope"]["capturedAt"] = "".into()),
            Box::new(|m| m["envelope"]["source"] = "ios".into()),
            Box::new(|m| m["screenshotBase64"] = "not base64!!!".into()),
        ];
        for mutate in cases {
            assert!(matches!(
                ValidatedCapture::parse(&payload(mutate)),
                Err(HostError::InvalidPayload(_))
            ));
        }
    }

    #[test]
    fn garbage_bytes_are_invalid_payload() {
        assert!(matches!(
            ValidatedCapture::parse(b"\x00\x01garbage"),
            Err(HostError::InvalidPayload(_))
        ));
    }
}
