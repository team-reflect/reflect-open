//! Chrome native-messaging framing: a 4-byte native-byte-order length prefix
//! followed by that many bytes of UTF-8 JSON, in both directions. Stdout must
//! stay protocol-pure — nothing else in this process writes to it.

use std::io::{ErrorKind, Read, Write};

/// Chrome caps extension→host messages at 64 MiB; anything larger is a
/// corrupt frame, not a real capture.
const MAX_INCOMING_BYTES: u32 = 64 * 1024 * 1024;

/// Read one framed message, or `None` on a clean EOF (Chrome closed the pipe).
pub fn read_message(input: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0u8; 4];
    match input.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_ne_bytes(length_bytes);
    if length > MAX_INCOMING_BYTES {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            format!("frame of {length} bytes exceeds the {MAX_INCOMING_BYTES}-byte cap"),
        ));
    }
    let mut payload = vec![0u8; length as usize];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// Write one framed message and flush — Chrome reads the first reply as the
/// `sendNativeMessage` response.
pub fn write_message(output: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(payload.len()).map_err(|_| {
        std::io::Error::new(ErrorKind::InvalidData, "ack exceeds the u32 frame length")
    })?;
    output.write_all(&length.to_ne_bytes())?;
    output.write_all(payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_a_message() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, b"{\"ok\":true}").unwrap();

        let mut cursor = Cursor::new(buffer);
        assert_eq!(
            read_message(&mut cursor).unwrap().as_deref(),
            Some(b"{\"ok\":true}".as_slice())
        );
        assert_eq!(read_message(&mut cursor).unwrap(), None);
    }

    #[test]
    fn clean_eof_reads_as_none() {
        let mut cursor = Cursor::new(Vec::new());
        assert_eq!(read_message(&mut cursor).unwrap(), None);
    }

    #[test]
    fn truncated_payload_is_an_error() {
        let mut bytes = 10u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"abc"); // promised 10, delivered 3
        let mut cursor = Cursor::new(bytes);
        assert!(read_message(&mut cursor).is_err());
    }

    #[test]
    fn oversized_frame_is_rejected_without_allocating() {
        let bytes = u32::MAX.to_ne_bytes().to_vec();
        let mut cursor = Cursor::new(bytes);
        assert!(read_message(&mut cursor).is_err());
    }
}
