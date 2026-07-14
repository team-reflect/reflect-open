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
    let Ok(request_path) = percent_encoding::percent_decode(encoded_path.as_bytes()).decode_utf8()
    else {
        responder.respond(status_response(StatusCode::BAD_REQUEST));
        return;
    };
    let request_path = request_path.into_owned();
    let preview_raster_only = requests_preview_raster(request.uri().query());
    let method_allowed = request.method() == tauri::http::Method::GET;
    tauri::async_runtime::spawn_blocking(move || {
        if !method_allowed {
            responder.respond(status_response(StatusCode::METHOD_NOT_ALLOWED));
            return;
        }
        responder.respond(response_for(&app, &request_path, preview_raster_only));
    });
}

fn response_for<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
    preview_raster_only: bool,
) -> Response<Cow<'static, [u8]>> {
    match serve(app, request_path) {
        Ok((mime, bytes)) => {
            if preview_raster_only && !is_preview_safe_raster_mime(&mime) {
                return status_response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
            }
            let is_svg = mime == "image/svg+xml";
            let mut response = Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, bytes.len())
                .header(header::CACHE_CONTROL, "no-store")
                .header("x-content-type-options", "nosniff");
            if is_svg {
                response = response.header(
                    "content-security-policy",
                    "sandbox; default-src 'none'; style-src 'unsafe-inline'",
                );
            }
            response
                .body(Cow::Owned(bytes))
                .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR))
        }
        Err(status) => {
            tracing::warn!(path = request_path, %status, "asset protocol refused a request");
            status_response(status)
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

fn serve<R: Runtime>(
    app: &AppHandle<R>,
    request_path: &str,
) -> Result<(String, Vec<u8>), StatusCode> {
    let (generation, rel) = parse_request_path(request_path)?;
    let state = app.state::<GraphState>();
    let root = super::root_for_generation(&state, generation).map_err(|_| StatusCode::FORBIDDEN)?;
    let abs = super::attachments::resolve_existing_path(&root, rel).map_err(|err| match err {
        crate::error::AppError::NotFound { .. } => StatusCode::NOT_FOUND,
        _ => StatusCode::FORBIDDEN,
    })?;
    // On an iCloud graph this read blocks until the file is materialized on
    // the device — acceptable here on the blocking pool, and exactly the wait
    // that must never happen on the UI thread.
    let bytes = std::fs::read(&abs).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    // Never let Tauri's default unknown-extension fallback (`text/html`) turn
    // arbitrary vault bytes into active web content. Known signatures win;
    // otherwise unsupported sniff results stay inert octet streams.
    let mime = sniff_mime(&bytes, rel);
    Ok((mime, bytes))
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
    use tauri::Manager;

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
        {
            let state: tauri::State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 7;
            inner.root = Some(graph.path().to_path_buf());
        }

        let response = response_for(app.handle(), "7/Projects/media/photo.png", true);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.body().as_ref(), b"\x89PNG\r\n\x1a\n");

        assert_eq!(
            response_for(app.handle(), "6/Projects/media/photo.png", true).status(),
            StatusCode::FORBIDDEN,
        );
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
        {
            let state: tauri::State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(graph.path().to_path_buf());
        }

        let response = response_for(app.handle(), "1/photo.png", false);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response_for(app.handle(), "1/photo.png", true).status(),
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
        {
            let state: tauri::State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 2;
            inner.root = Some(graph.path().to_path_buf());
        }

        let response = response_for(app.handle(), "2/diagram.svg", false);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert_eq!(
            response.headers()["content-security-policy"],
            "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        );
        assert_eq!(
            response_for(app.handle(), "2/diagram.svg", true).status(),
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
        {
            let state: tauri::State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 3;
            inner.root = Some(graph.path().to_path_buf());
        }

        assert_eq!(
            response_for(app.handle(), "3/link.png", false).status(),
            StatusCode::FORBIDDEN,
        );
    }
}
