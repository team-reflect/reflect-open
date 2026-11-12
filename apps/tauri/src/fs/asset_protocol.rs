//! The `reflect-asset://` custom protocol: serves graph `assets/` files to
//! and archived X media to the webview **off the UI thread**.
//! `Core::asset_resolve` decides which file a request names, its MIME type
//! and the bytes a `Range` header selects; this handler reads and answers.
//!
//! WebKit delivers custom-scheme requests on the main thread and wry invokes
//! the handler inline, so Tauri's built-in synchronous `asset:` protocol
//! freezes the app for the duration of every uncached image read, and a first
//! read can wait for iCloud to materialize a dataless file. This handler does
//! the blocking file IO on the async runtime's blocking pool and responds when
//! the bytes are ready, so a slow read costs the image a pop-in, never the app
//! a freeze.
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
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use reflect_core::Core;
use reflect_core::fs::asset_request::{AssetFile, AssetRefusal};
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::error::AppResult;

/// The scheme name, shared with the `lib.rs` registration. The frontend and
/// the CSP `img-src` grant in `tauri.conf.json` spell it out literally.
pub(crate) const SCHEME: &str = "reflect-asset";

/// Protocol entry point (`register_asynchronous_uri_scheme_protocol`). Runs
/// on the webview's calling thread — on WebKit, the app's main thread — so it
/// only moves the request onto the async runtime; all IO happens there.
pub(crate) fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let core = Arc::clone(ctx.app_handle().state::<Arc<Core>>().inner());
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(&core, &request).await);
    });
}

async fn serve(core: &Core, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.method() != Method::GET {
        return refusal(StatusCode::METHOD_NOT_ALLOWED.as_u16(), None);
    }
    // Skip the leading `/`; the remainder is one percent-encoded segment.
    let request_path = percent_encoding::percent_decode(&request.uri().path().as_bytes()[1..])
        .decode_utf8_lossy()
        .into_owned();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let file = match core
        .asset_resolve(&request_path, request.uri().query(), range)
        .await
    {
        Ok(file) => file,
        Err(AssetRefusal { status, total }) => {
            tracing::warn!(
                path = request_path,
                status,
                "asset protocol refused a request"
            );
            return refusal(status, total);
        }
    };
    let AssetFile {
        path,
        mime,
        total,
        range,
    } = file;
    let (first, last) = range.unwrap_or((0, total.saturating_sub(1)));
    let count = if total == 0 { 0 } else { last - first + 1 };
    // On an iCloud graph this read blocks until the file is materialized on
    // the device — acceptable here on the blocking pool, and exactly the wait
    // that must never happen on the UI thread.
    let bytes = core
        .spawn_blocking(move || -> AppResult<Vec<u8>> {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(first))?;
            let mut bytes = vec![0; count as usize];
            file.read_exact(&mut bytes)?;
            Ok(bytes)
        })
        .await;
    let Ok(bytes) = bytes else {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR.as_u16(), None);
    };
    let mut response = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, count)
        .header(header::ACCEPT_RANGES, "bytes");
    if range.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {first}-{last}/{total}"),
        );
    }
    response
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| refusal(StatusCode::INTERNAL_SERVER_ERROR.as_u16(), None))
}

/// A status-only response. `total` is the file length of a 416.
fn refusal(status: u16, total: Option<u64>) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(total) = total {
        response = response.header(header::CONTENT_RANGE, format!("bytes */{total}"));
    }
    response
        .body(Cow::Borrowed(&[][..]))
        .expect("a status-only response always builds")
}
