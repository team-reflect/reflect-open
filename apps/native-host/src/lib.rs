//! The Chrome native-messaging host (Plan 11). Chrome spawns this binary per
//! capture (`runtime.sendNativeMessage`); it validates the wire message and
//! **spools** it into the active graph's capture inbox
//! (`<graph>/.reflect/inbox/`), then acks `queued` and exits. It is a spooler,
//! not a relay: it never talks to the running app — the inbox *is* the IPC,
//! drained by the desktop app's watcher (or on next launch when the app is
//! closed).
//!
//! Protocol discipline: stdout carries nothing but length-prefixed JSON acks;
//! all logging goes to stderr. The wire shapes mirror the zod schemas in
//! `@reflect/core` (`actions/capture-envelope.ts`) — that TS file is the
//! source of truth.

pub mod envelope;
pub mod protocol;
pub mod spool;

use std::io::{Read, Write};
use std::path::Path;

use envelope::ValidatedCapture;
use protocol::{read_message, write_message};
use spool::{inbox_dir, spool_capture};

/// Why a capture could not be spooled, as acked to the extension.
#[derive(Debug, PartialEq)]
pub enum HostError {
    /// No pointer file — the app has never opened a graph on this machine.
    NoGraph,
    /// The wire message failed validation.
    InvalidPayload(String),
    /// The spool write (or pointer read) failed.
    Io(String),
}

impl HostError {
    fn code(&self) -> &'static str {
        match self {
            HostError::NoGraph => "no-graph",
            HostError::InvalidPayload(_) => "invalid-payload",
            HostError::Io(_) => "io",
        }
    }

    fn message(&self) -> String {
        match self {
            HostError::NoGraph => "Open Reflect and pick a graph first.".to_string(),
            HostError::InvalidPayload(message) | HostError::Io(message) => message.clone(),
        }
    }
}

/// The ack for one message: `{ok:true,status:"queued"}` or a typed error.
/// `queued` is the only success the host can honestly claim — it never
/// observes the desktop app draining the inbox.
fn ack_json(outcome: &Result<(), HostError>) -> Vec<u8> {
    let value = match outcome {
        Ok(()) => serde_json::json!({ "ok": true, "status": "queued" }),
        Err(error) => serde_json::json!({
            "ok": false,
            "code": error.code(),
            "message": error.message(),
        }),
    };
    value.to_string().into_bytes()
}

/// Handle one wire message: validate, locate the inbox, spool.
fn handle_message(payload: &[u8], pointer_path: &Path) -> Result<(), HostError> {
    let capture = ValidatedCapture::parse(payload)?;
    let inbox = inbox_dir(pointer_path)?;
    spool_capture(&inbox, &capture)
}

/// The host's whole life: read length-prefixed messages until EOF, ack each.
/// `sendNativeMessage` sends exactly one message and closes the pipe, but the
/// loop also serves a long-lived `connectNative` port if one is ever used.
pub fn run(
    input: &mut impl Read,
    output: &mut impl Write,
    pointer_path: &Path,
) -> std::io::Result<()> {
    while let Some(payload) = read_message(input)? {
        let outcome = handle_message(&payload, pointer_path);
        if let Err(error) = &outcome {
            eprintln!("reflect-capture-host: {error:?}");
        }
        write_message(output, &ack_json(&outcome))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn wire(envelope: serde_json::Value, screenshot: Option<&str>) -> Vec<u8> {
        let mut message = serde_json::json!({ "envelope": envelope });
        if let Some(bytes) = screenshot {
            message["screenshotBase64"] = serde_json::Value::String(bytes.to_string());
        }
        message.to_string().into_bytes()
    }

    fn valid_envelope() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            "url": "https://example.com/article",
            "title": "An article",
            "capturedAt": "2026-06-12T15:30:22.845Z",
            "source": "extension",
        })
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut bytes = (payload.len() as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    fn read_ack(output: &[u8]) -> serde_json::Value {
        let mut cursor = Cursor::new(output);
        let payload = read_message(&mut cursor).unwrap().expect("an ack");
        serde_json::from_slice(&payload).unwrap()
    }

    #[test]
    fn spools_a_capture_and_acks_queued() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(&graph).unwrap();
        let pointer = dir.path().join("capture-pointer.json");
        std::fs::write(
            &pointer,
            serde_json::json!({ "version": 1, "graphRoot": graph.to_string_lossy() }).to_string(),
        )
        .unwrap();

        let message = wire(valid_envelope(), Some("aGVsbG8=")); // "hello"
        let mut input = Cursor::new(framed(&message));
        let mut output = Vec::new();
        run(&mut input, &mut output, &pointer).unwrap();

        assert_eq!(
            read_ack(&output),
            serde_json::json!({ "ok": true, "status": "queued" })
        );
        let inbox = graph.join(".reflect/inbox");
        let id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        assert_eq!(
            std::fs::read(inbox.join(format!("{id}.jpg"))).unwrap(),
            b"hello"
        );
        let spooled: serde_json::Value =
            serde_json::from_slice(&std::fs::read(inbox.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(spooled["screenshotRef"], format!("{id}.jpg"));
        assert_eq!(spooled["url"], "https://example.com/article");
    }

    #[test]
    fn missing_pointer_acks_no_graph() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("does-not-exist.json");

        let message = wire(valid_envelope(), None);
        let mut input = Cursor::new(framed(&message));
        let mut output = Vec::new();
        run(&mut input, &mut output, &pointer).unwrap();

        let ack = read_ack(&output);
        assert_eq!(ack["ok"], false);
        assert_eq!(ack["code"], "no-graph");
    }

    #[test]
    fn invalid_payload_acks_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("capture-pointer.json");

        let mut input = Cursor::new(framed(b"not json at all"));
        let mut output = Vec::new();
        run(&mut input, &mut output, &pointer).unwrap();

        let ack = read_ack(&output);
        assert_eq!(ack["ok"], false);
        assert_eq!(ack["code"], "invalid-payload");
    }
}
