//! The `reflect-asset://` custom protocol: serves supported graph attachments to
//! the webview **off the UI thread**.
//!
//! WebKit delivers custom-scheme requests on the main thread and wry invokes
//! the handler inline, so Tauri's built-in synchronous `asset:` protocol
//! froze the app for the duration of every uncached image read. On iOS that
//! was seconds: a first read can also wait for iCloud to materialize a
//! dataless file. This handler does the blocking file IO on the async
//! runtime's blocking pool and responds when the bytes are ready, so a slow
//! read costs the image a pop-in, never the app a freeze.
//!
//! URL shape: `reflect-asset://localhost/<generation>/<graph-relative path>`,
//! built by `convertFileSrc(…, 'reflect-asset')` in the frontend (which
//! percent-encodes the whole path into one segment). The generation pins the
//! request to the graph session that issued it, exactly like mutating
//! commands — a request racing a graph switch is refused, never resolved
//! against the new graph. The path must be a supported visible attachment and
//! passes the symlink-aware traversal guard before any IO.
//! Passive previews append `?reflect-preview=raster`; those responses are
//! served only when byte sniffing identifies an accepted raster image,
//! so an SVG renamed with a raster extension cannot load subresources there.

use std::borrow::Cow;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::GraphState;

/// The scheme name, shared with the `lib.rs` registration. The frontend and
/// the CSP `img-src` grant in `tauri.conf.json` spell it out literally.
pub(crate) const SCHEME: &str = "reflect-asset";
const PREVIEW_RASTER_QUERY: &str = "reflect-preview=raster";
const MIME_SNIFF_BYTES: u64 = 8 * 1024;
const MAX_UNRANGED_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;
// Image elements do not retry a 413 with byte ranges, so give classified images
// the same bounded ceiling as explicit native asset reads.
const MAX_UNRANGED_IMAGE_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RANGE_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

struct ServedAsset {
    mime: String,
    bytes: Vec<u8>,
    total_len: u64,
    range: Option<ByteRange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

enum ServeError {
    Status(StatusCode),
    RangeNotSatisfiable(u64),
}

/// Protocol entry point (`register_asynchronous_uri_scheme_protocol`). Runs
/// on the webview's calling thread — on WebKit, the app's main thread — so it
/// only moves the request onto the blocking pool; all IO happens there.
pub(crate) fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // Skip the leading `/`; the remainder is one percent-encoded segment.
    let Some(encoded_path) = request.uri().path().strip_prefix('/') else {
        responder.respond(status_response(StatusCode::BAD_REQUEST));
        return;
    };
    let Ok(request_path) = decode_request_path(encoded_path) else {
        responder.respond(status_response(StatusCode::BAD_REQUEST));
        return;
    };
    let range_header = match request.headers().get(header::RANGE) {
        Some(value) => match value.to_str() {
            Ok(value) => Some(value.to_string()),
            Err(_) => {
                responder.respond(status_response(StatusCode::BAD_REQUEST));
                return;
            }
        },
        None => None,
    };
    let preview_raster_only = requests_preview_raster(request.uri().query());
    let method_allowed = request.method() == tauri::http::Method::GET;
    tauri::async_runtime::spawn_blocking(move || {
        if !method_allowed {
            responder.respond(status_response(StatusCode::METHOD_NOT_ALLOWED));
            return;
        }
        responder.respond(response_for(
            &app,
            &request_path,
            preview_raster_only,
            range_header.as_deref(),
        ));
    });
}

fn decode_request_path(encoded_path: &str) -> Result<String, StatusCode> {
    let bytes = encoded_path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some(encoded_byte) = bytes.get(index + 1..index + 3) else {
                return Err(StatusCode::BAD_REQUEST);
            };
            if !encoded_byte.iter().all(u8::is_ascii_hexdigit) {
                return Err(StatusCode::BAD_REQUEST);
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    percent_encoding::percent_decode(bytes)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| StatusCode::BAD_REQUEST)
}

fn response_for<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
    preview_raster_only: bool,
    range_header: Option<&str>,
) -> Response<Cow<'static, [u8]>> {
    match serve(app, request_path, range_header) {
        Ok(asset) => {
            if preview_raster_only && !is_preview_safe_raster_mime(&asset.mime) {
                return status_response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
            }
            let is_svg = asset.mime == "image/svg+xml";
            let mut response = Response::builder()
                .header(header::CONTENT_TYPE, asset.mime)
                .header(header::CONTENT_LENGTH, asset.bytes.len())
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "no-store")
                .header("x-content-type-options", "nosniff");
            if let Some(range) = asset.range {
                response = response.status(StatusCode::PARTIAL_CONTENT).header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", range.start, range.end, asset.total_len),
                );
            }
            if is_svg {
                response = response.header(
                    "content-security-policy",
                    "sandbox; default-src 'none'; style-src 'unsafe-inline'",
                );
            }
            response
                .body(Cow::Owned(asset.bytes))
                .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR))
        }
        Err(ServeError::Status(status)) => {
            tracing::warn!(path = request_path, %status, "asset protocol refused a request");
            if status == StatusCode::PAYLOAD_TOO_LARGE {
                range_required_response()
            } else {
                status_response(status)
            }
        }
        Err(ServeError::RangeNotSatisfiable(total_len)) => {
            tracing::warn!(
                path = request_path,
                "asset protocol refused an invalid range"
            );
            range_not_satisfiable_response(total_len)
        }
    }
}

fn requests_preview_raster(query: Option<&str>) -> bool {
    query.is_some_and(|query| {
        query
            .split('&')
            .any(|parameter| parameter == PREVIEW_RASTER_QUERY)
    })
}

fn is_preview_safe_raster_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    )
}

fn status_response(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(&[][..]))
        .expect("a status-only response always builds")
}

fn range_not_satisfiable_response(total_len: u64) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(&[][..]))
        .expect("a range error response always builds")
}

fn range_required_response() -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::PAYLOAD_TOO_LARGE)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(&[][..]))
        .expect("a range-required response always builds")
}

fn serve<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
    range_header: Option<&str>,
) -> Result<ServedAsset, ServeError> {
    let (generation, rel) = parse_request_path(request_path).map_err(ServeError::Status)?;
    let state = app.state::<GraphState>();
    let root = super::pinned_root_for_generation(&state, generation)
        .map_err(|_| ServeError::Status(StatusCode::FORBIDDEN))?;
    let mut attachment =
        super::attachments::open_existing_attachment(&root, rel).map_err(|err| match err {
            crate::error::AppError::NotFound { .. } => ServeError::Status(StatusCode::NOT_FOUND),
            _ => ServeError::Status(StatusCode::FORBIDDEN),
        })?;
    let total_len = attachment.len().map_err(map_read_error)?;

    // Sniff only a small prefix, then seek and read the selected bounded range
    // from this same capability-opened descriptor. Resolving the pathname
    // again would reintroduce a symlink-swap window after validation.
    let sniff_len = total_len.min(MIME_SNIFF_BYTES);
    let sniffed_bytes = attachment
        .read_range(0, sniff_len, MIME_SNIFF_BYTES)
        .map_err(map_read_error)?;
    // Never let Tauri's default unknown-extension fallback (`text/html`) turn
    // arbitrary vault bytes into active web content. Known signatures win;
    // otherwise unsupported sniff results stay inert octet streams.
    let mime = sniff_mime(&sniffed_bytes, rel);
    let max_unranged_bytes = if mime.starts_with("image/") {
        MAX_UNRANGED_IMAGE_RESPONSE_BYTES
    } else {
        MAX_UNRANGED_RESPONSE_BYTES
    };
    let selected_range = match range_header {
        Some(value) => Some(
            parse_range(value, total_len, MAX_RANGE_RESPONSE_BYTES)
                .map_err(|()| ServeError::RangeNotSatisfiable(total_len))?,
        ),
        None if total_len > max_unranged_bytes => {
            return Err(ServeError::Status(StatusCode::PAYLOAD_TOO_LARGE));
        }
        None => None,
    };
    let (start, length) = selected_range.map_or((0, total_len), |range| {
        (range.start, range.end - range.start + 1)
    });
    let max_bytes = if selected_range.is_some() {
        MAX_RANGE_RESPONSE_BYTES
    } else {
        max_unranged_bytes
    };
    let bytes = attachment
        .read_range(start, length, max_bytes)
        .map_err(map_read_error)?;
    Ok(ServedAsset {
        mime,
        bytes,
        total_len,
        range: selected_range,
    })
}

fn map_read_error(error: std::io::Error) -> ServeError {
    ServeError::Status(match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    })
}

fn parse_range(value: &str, total_len: u64, max_bytes: u64) -> Result<ByteRange, ()> {
    let range = value.trim().strip_prefix("bytes=").ok_or(())?;
    if total_len == 0 || max_bytes == 0 || range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix_len: u64 = end.parse().map_err(|_| ())?;
        if suffix_len == 0 {
            return Err(());
        }
        let selected_len = suffix_len.min(total_len).min(max_bytes);
        return Ok(ByteRange {
            start: total_len - selected_len,
            end: total_len - 1,
        });
    }

    let start: u64 = start.parse().map_err(|_| ())?;
    if start >= total_len {
        return Err(());
    }
    let requested_end = if end.is_empty() {
        total_len - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(total_len - 1)
    };
    if requested_end < start {
        return Err(());
    }
    let max_end = start.saturating_add(max_bytes - 1).min(total_len - 1);
    Ok(ByteRange {
        start,
        end: requested_end.min(max_end),
    })
}

fn sniff_mime(bytes: &[u8], path: &str) -> String {
    if path
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("svg"))
    {
        return "image/svg+xml".to_string();
    }
    let sniffed = MimeType::parse_with_fallback(bytes, path, MimeType::OctetStream);
    if is_safe_attachment_mime(&sniffed) {
        sniffed
    } else {
        "application/octet-stream".to_string()
    }
}

fn is_safe_attachment_mime(mime: &str) -> bool {
    matches!(
        mime,
        "application/pdf"
            | "audio/3gpp"
            | "audio/flac"
            | "audio/mp4"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "audio/webm"
            | "audio/x-flac"
            | "audio/x-wav"
            | "image/avif"
            | "image/bmp"
            | "image/gif"
            | "image/jpeg"
            | "image/png"
            | "image/svg+xml"
            | "image/webp"
            | "video/3gpp"
            | "video/mp4"
            | "video/ogg"
            | "video/quicktime"
            | "video/webm"
            | "video/x-matroska"
    )
}

/// Split `<generation>/<graph-relative path>` and vet the path shape. Serving
/// revalidates this lexical policy plus the filesystem's symlink state.
fn parse_request_path(request_path: &str) -> Result<(u64, &str), StatusCode> {
    let (generation, rel) = request_path
        .split_once('/')
        .ok_or(StatusCode::BAD_REQUEST)?;
    let generation: u64 = generation.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    super::attachments::ensure_supported_path(rel).map_err(|_| StatusCode::FORBIDDEN)?;
    Ok((generation, rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use std::path::Path;
    use std::sync::Arc;
    use tauri::Manager;

    fn set_graph<R: tauri::Runtime>(app: &tauri::App<R>, root: &Path, generation: u64) {
        let state: tauri::State<GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = generation;
        inner.root = Some(root.to_path_buf());
        inner.root_capability = Some(Arc::new(
            Dir::open_ambient_dir(root, ambient_authority()).unwrap(),
        ));
    }

    #[test]
    fn parses_a_generation_pinned_asset_path() {
        assert_eq!(
            parse_request_path("3/assets/cat.png").unwrap(),
            (3, "assets/cat.png"),
        );
        assert_eq!(
            parse_request_path("12/Projects/sub dir/photo 1.JPEG").unwrap(),
            (12, "Projects/sub dir/photo 1.JPEG"),
        );
        assert_eq!(
            parse_request_path("8/manual.pdf").unwrap(),
            (8, "manual.pdf")
        );
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(
            parse_request_path("assets/cat.png").unwrap_err(),
            StatusCode::BAD_REQUEST,
        );
        assert_eq!(
            parse_request_path("3").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            parse_request_path("nope/assets/cat.png").unwrap_err(),
            StatusCode::BAD_REQUEST,
        );
    }

    #[test]
    fn request_path_decoding_rejects_malformed_percent_escapes() {
        assert_eq!(
            decode_request_path("3/assets/bad%GG.png").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            decode_request_path("3/assets/bad%.png").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            decode_request_path("3/assets/bad%2.png").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            decode_request_path("3/Projects/photo%201.png").unwrap(),
            "3/Projects/photo 1.png"
        );
        assert_eq!(
            decode_request_path("3/Projects/100%25.png").unwrap(),
            "3/Projects/100%.png"
        );
    }

    #[test]
    fn byte_ranges_are_bounded_and_validate_unsatisfiable_requests() {
        assert_eq!(
            parse_range("bytes=2-5", 10, 8).unwrap(),
            ByteRange { start: 2, end: 5 }
        );
        assert_eq!(
            parse_range("bytes=2-", 20, 4).unwrap(),
            ByteRange { start: 2, end: 5 }
        );
        assert_eq!(
            parse_range("bytes=-3", 10, 8).unwrap(),
            ByteRange { start: 7, end: 9 }
        );
        assert_eq!(
            parse_range("bytes=-20", 10, 4).unwrap(),
            ByteRange { start: 6, end: 9 }
        );
        for invalid in [
            "items=0-1",
            "bytes=",
            "bytes=5-4",
            "bytes=10-",
            "bytes=0-1,3-4",
        ] {
            assert!(parse_range(invalid, 10, 8).is_err(), "{invalid}");
        }
        assert!(parse_range("bytes=0-", 0, 8).is_err());
    }

    #[test]
    fn rejects_non_attachments_and_unsafe_paths() {
        assert_eq!(
            parse_request_path("3/notes/secret.md").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/.hidden/cat.png").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/Projects/../cat.png").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/Projects/payload.html").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
    }

    #[test]
    fn recognizes_only_the_explicit_preview_raster_query() {
        assert!(requests_preview_raster(Some("reflect-preview=raster")));
        assert!(requests_preview_raster(Some(
            "cache=1&reflect-preview=raster"
        )));
        assert!(!requests_preview_raster(None));
        assert!(!requests_preview_raster(Some("reflect-preview=svg")));
    }

    #[test]
    fn preview_raster_filter_uses_sniffed_content_not_the_filename() {
        let disguised_svg = br#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#;
        let svg_mime = sniff_mime(disguised_svg, "assets/disguised.png");
        assert_ne!(svg_mime, "image/png");
        assert!(!is_preview_safe_raster_mime(&svg_mime));

        let png_signature = b"\x89PNG\r\n\x1a\n";
        let png_mime = sniff_mime(png_signature, "assets/image.bin");
        assert_eq!(png_mime, "image/png");
        assert!(is_preview_safe_raster_mime(&png_mime));
        assert_eq!(
            sniff_mime(b"<svg></svg>", "Media/diagram.SVG"),
            "image/svg+xml"
        );
    }

    #[test]
    fn serves_nested_attachments_with_generation_and_security_headers() {
        let graph = tempfile::tempdir().unwrap();
        let path = graph.path().join("Projects/media/photo.png");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 7);

        let response = response_for(app.handle(), "7/Projects/media/photo.png", true, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.body().as_ref(), b"\x89PNG\r\n\x1a\n");

        assert_eq!(
            response_for(app.handle(), "6/Projects/media/photo.png", true, None).status(),
            StatusCode::FORBIDDEN,
        );
    }

    #[test]
    fn serves_descriptor_backed_ranges_and_reports_invalid_ranges() {
        let graph = tempfile::tempdir().unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nabcdefgh";
        std::fs::write(graph.path().join("photo.png"), bytes).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 8);

        let response = response_for(app.handle(), "8/photo.png", false, Some("bytes=8-11"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 8-11/16");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(response.body().as_ref(), b"abcd");

        let invalid = response_for(app.handle(), "8/photo.png", false, Some("bytes=20-"));
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(invalid.headers()[header::CONTENT_RANGE], "bytes */16");
        assert!(invalid.body().is_empty());
    }

    #[test]
    fn refuses_to_buffer_large_assets_without_a_range() {
        let graph = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(graph.path().join("large.pdf")).unwrap();
        file.set_len(MAX_UNRANGED_RESPONSE_BYTES + 1).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 9);

        let response = response_for(app.handle(), "9/large.pdf", false, None);
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(response.body().is_empty());

        let ranged = response_for(app.handle(), "9/large.pdf", false, Some("bytes=0-15"));
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.body().len(), 16);
    }

    #[test]
    fn serves_large_images_up_to_the_bounded_image_limit() {
        let graph = tempfile::tempdir().unwrap();
        let path = graph.path().join("large.png");
        let mut file = std::fs::File::create(&path).unwrap();
        std::io::Write::write_all(&mut file, b"\x89PNG\r\n\x1a\n").unwrap();
        file.set_len(MAX_UNRANGED_RESPONSE_BYTES + 1).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 10);

        let response = response_for(app.handle(), "10/large.png", false, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            response.body().len() as u64,
            MAX_UNRANGED_RESPONSE_BYTES + 1
        );

        file.set_len(MAX_UNRANGED_IMAGE_RESPONSE_BYTES + 1).unwrap();
        let oversized = response_for(app.handle(), "10/large.png", false, None);
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(oversized.body().is_empty());
    }

    #[test]
    fn inert_fallback_cannot_be_rendered_as_a_raster_preview() {
        let graph = tempfile::tempdir().unwrap();
        let path = graph.path().join("photo.png");
        std::fs::write(&path, b"<html><script>bad()</script></html>").unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 1);

        let response = response_for(app.handle(), "1/photo.png", false, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response_for(app.handle(), "1/photo.png", true, None).status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        );
    }

    #[test]
    fn svg_responses_are_sandboxed() {
        let graph = tempfile::tempdir().unwrap();
        std::fs::write(graph.path().join("diagram.svg"), b"<svg></svg>").unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 2);

        let response = response_for(app.handle(), "2/diagram.svg", false, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert_eq!(
            response.headers()["content-security-policy"],
            "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        );
        assert_eq!(
            response_for(app.handle(), "2/diagram.svg", true, None).status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        );
    }

    #[cfg(unix)]
    #[test]
    fn protocol_refuses_symlinks_even_when_the_target_stays_in_the_graph() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        std::fs::write(graph.path().join("real.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        symlink(graph.path().join("real.png"), graph.path().join("link.png")).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, graph.path(), 3);

        assert_eq!(
            response_for(app.handle(), "3/link.png", false, None).status(),
            StatusCode::FORBIDDEN,
        );
    }

    #[cfg(unix)]
    #[test]
    fn protocol_reads_from_the_generation_pinned_root_after_path_replacement() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("vault");
        let moved_root = parent.path().join("moved-vault");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("photo.png"), b"\x89PNG\r\n\x1a\nvault").unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        set_graph(&app, &root, 4);

        std::fs::rename(&root, &moved_root).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("photo.png"), b"\x89PNG\r\n\x1a\nreplacement").unwrap();

        let response = response_for(app.handle(), "4/photo.png", false, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_ref(), b"\x89PNG\r\n\x1a\nvault");
    }
}
