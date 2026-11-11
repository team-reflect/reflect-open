use reflect_core::Core;
use reflect_core::fs::x_media_protocol::{XMediaFile, parse_x_media_path};
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};

fn error(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    let builder = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store");
    builder
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("valid response")
}
fn status_code(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}
fn range(header: Option<&str>, length: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    let ranges = http_range_header::parse_range_header(header)
        .and_then(|parsed| parsed.validate(length))
        .map_err(|_| ())?;
    if ranges.len() != 1 {
        return Ok(None);
    }
    Ok(Some((*ranges[0].start(), *ranges[0].end())))
}
pub fn handle<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    path: String,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let response = serve(app, request, path).await;
        responder.respond(response);
    });
}
async fn serve<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    path: String,
) -> Response<Cow<'static, [u8]>> {
    let media = match parse_x_media_path(&path) {
        Ok(media) => media,
        Err(status) => return error(status_code(status)),
    };
    if request.method() != "GET" {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let core = Arc::clone(app.state::<Arc<Core>>().inner());
    let XMediaFile { root, receipt } = match core.x_media_file(media).await {
        Ok(file) => file,
        Err(status) => return error(status_code(status)),
    };
    let selected = match range(
        request
            .headers()
            .get("Range")
            .and_then(|value| value.to_str().ok()),
        receipt.bytes,
    ) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(416)
                .header("Content-Range", format!("bytes */{}", receipt.bytes))
                .header("Cache-Control", "no-store")
                .body(Cow::Borrowed(&[] as &[u8]))
                .expect("valid response");
        }
    };
    let (start, end) = selected.unwrap_or((0, receipt.bytes - 1));
    let count = end - start + 1;
    let name = receipt.name.clone();
    let body = tauri::async_runtime::spawn_blocking(move || -> crate::error::AppResult<Vec<u8>> {
        let path = super::resolve(&root, &format!("assets/x/{name}"))?;
        let mut file = File::open(path)?;
        if file.metadata()?.len() != receipt.bytes {
            return Err(crate::error::AppError::io("file-changed"));
        }
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; count as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    })
    .await
    .unwrap_or_else(|error| Err(crate::error::AppError::io(error.to_string())));
    let Ok(bytes) = body else {
        return error(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut builder = Response::builder()
        .status(if selected.is_some() { 206 } else { 200 })
        .header("Content-Type", receipt.mime)
        .header("Content-Length", count)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store");
    if selected.is_some() {
        builder = builder.header(
            "Content-Range",
            format!("bytes {start}-{end}/{}", receipt.bytes),
        );
    }
    builder.body(Cow::Owned(bytes)).expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::range;
    #[test]
    fn supports_video_ranges_and_rejects_unsatisfiable_ranges() {
        assert_eq!(range(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(range(Some("bytes=7-"), 10), Ok(Some((7, 9))));
        assert!(range(Some("bytes=10-"), 10).is_err());
    }
}
