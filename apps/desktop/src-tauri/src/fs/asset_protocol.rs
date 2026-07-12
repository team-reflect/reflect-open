//! The `reflect-asset://` custom protocol: serves graph `assets/` files to
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
//! against the new graph. The path must live under `assets/` and passes the
//! shared symlink-aware traversal guard before any IO.
//! Passive previews append `?reflect-preview=raster`; those responses are
//! served only when byte sniffing identifies PNG, JPEG, GIF, or WebP content,
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
    let request_path = percent_encoding::percent_decode(&request.uri().path().as_bytes()[1..])
        .decode_utf8_lossy()
        .into_owned();
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
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, bytes.len())
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
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn status_response(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
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
    let abs = super::resolve::resolve(&root, rel).map_err(|_| StatusCode::FORBIDDEN)?;
    // On an iCloud graph this read blocks until the file is materialized on
    // the device — acceptable here on the blocking pool, and exactly the wait
    // that must never happen on the UI thread.
    let bytes = std::fs::read(&abs).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    let mime = MimeType::parse(&bytes, rel);
    Ok((mime, bytes))
}

/// Split `<generation>/<graph-relative path>` and vet the path shape. The
/// `assets/` restriction mirrors `asset_open`: images in note markdown are
/// the only consumer, and they never reference anything else.
fn parse_request_path(request_path: &str) -> Result<(u64, &str), StatusCode> {
    let (generation, rel) = request_path
        .split_once('/')
        .ok_or(StatusCode::BAD_REQUEST)?;
    let generation: u64 = generation.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    super::ensure_asset_path(rel).map_err(|_| StatusCode::FORBIDDEN)?;
    Ok((generation, rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_generation_pinned_asset_path() {
        assert_eq!(
            parse_request_path("3/assets/cat.png").unwrap(),
            (3, "assets/cat.png"),
        );
        assert_eq!(
            parse_request_path("12/assets/sub dir/photo 1.jpeg").unwrap(),
            (12, "assets/sub dir/photo 1.jpeg"),
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
    fn rejects_paths_outside_assets() {
        assert_eq!(
            parse_request_path("3/notes/secret.md").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets").unwrap_err(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets/").unwrap_err(),
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
        let svg_mime = MimeType::parse(disguised_svg, "assets/disguised.png");
        assert_ne!(svg_mime, "image/png");
        assert!(!is_preview_safe_raster_mime(&svg_mime));

        let png_signature = b"\x89PNG\r\n\x1a\n";
        let png_mime = MimeType::parse(png_signature, "assets/image.bin");
        assert_eq!(png_mime, "image/png");
        assert!(is_preview_safe_raster_mime(&png_mime));
    }
}
