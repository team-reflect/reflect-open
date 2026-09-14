use super::GraphState;
use reflect_x_archive as archive;
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};

fn error(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store");
    if status == StatusCode::SERVICE_UNAVAILABLE {
        builder = builder.header("Retry-After", "2");
    }
    builder
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("valid response")
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
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() != 4 || segments[1] != "x-media" {
        return error(StatusCode::BAD_REQUEST);
    }
    let Ok(generation) = segments[0].parse::<u64>() else {
        return error(StatusCode::BAD_REQUEST);
    };
    let post = segments[2].to_string();
    let hash = segments[3].to_string();
    if !archive::valid_id(&post) || !archive::valid_hash(&hash) {
        return error(StatusCode::BAD_REQUEST);
    }
    if request.method() != "GET" {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(root) = super::root_for_generation(&app.state::<GraphState>(), generation) else {
        return error(StatusCode::FORBIDDEN);
    };
    let lookup_root = root.clone();
    let source = tauri::async_runtime::spawn_blocking(move || {
        archive::resource_url(&lookup_root, &post, &hash)
    })
    .await;
    let Ok(Ok(source)) = source else {
        return error(StatusCode::NOT_FOUND);
    };
    // Keep this request pending until the shared download publishes a complete file.
    let Ok(receipt) = super::x_download::download(root.clone(), source).await else {
        return error(StatusCode::BAD_GATEWAY);
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
                .expect("valid response")
        }
    };
    let (start, end) = selected.unwrap_or((0, receipt.bytes - 1));
    let count = end - start + 1;
    let name = receipt.name.clone();
    let body = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let path = archive::safe_path(&root, &format!("assets/x/{name}"))?;
        let mut file = File::open(path)?;
        anyhow::ensure!(file.metadata()?.len() == receipt.bytes, "file-changed");
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; count as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    })
    .await
    .unwrap_or_else(|error| Err(error.into()));
    // Do not deliver a response from the previous graph after a graph switch.
    if super::root_for_generation(&app.state::<GraphState>(), generation).is_err() {
        return error(StatusCode::FORBIDDEN);
    }
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
