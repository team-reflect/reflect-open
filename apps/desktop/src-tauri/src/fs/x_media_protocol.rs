use super::GraphState;
use reflect_x_archive as archive;
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};
use tokio::sync::Semaphore;

fn waiters() -> &'static Arc<Semaphore> {
    static VALUE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    VALUE.get_or_init(|| Arc::new(Semaphore::new(128)))
}
fn readers() -> &'static Arc<Semaphore> {
    static VALUE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    VALUE.get_or_init(|| Arc::new(Semaphore::new(2)))
}
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
    let Some(value) = header.strip_prefix("bytes=") else {
        return Ok(None);
    };
    if value.contains(',') {
        return Ok(None);
    }
    let Some((left, right)) = value.split_once('-') else {
        return Ok(None);
    };
    if left.is_empty() {
        let Ok(suffix) = right.parse::<u64>() else {
            return Ok(None);
        };
        if suffix == 0 || length == 0 {
            return Err(());
        }
        return Ok(Some((length.saturating_sub(suffix), length - 1)));
    }
    let Ok(start) = left.parse::<u64>() else {
        return Ok(None);
    };
    let end = if right.is_empty() {
        length.saturating_sub(1)
    } else {
        match right.parse::<u64>() {
            Ok(end) => end,
            Err(_) => return Ok(None),
        }
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok(Some((start, end.min(length - 1))))
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
    let head = request.method() == "HEAD";
    if request.method() != "GET" && !head {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(_waiter) = waiters().clone().try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE);
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let receipt = loop {
        let Ok(root) = super::root_for_generation(&app.state::<GraphState>(), generation) else {
            return error(StatusCode::FORBIDDEN);
        };
        let post = post.clone();
        let hash = hash.clone();
        let job = tauri::async_runtime::spawn_blocking(move || {
            archive::ensure_resource(&root, &post, &hash)
        })
        .await;
        match job {
            Ok(Ok(job)) if job.state == "stored" => {
                if let Some(receipt) = job.receipt {
                    break receipt;
                }
            }
            Ok(Ok(job)) if job.state == "unsupported" || job.state == "failed" => {
                return error(StatusCode::UNPROCESSABLE_ENTITY)
            }
            Ok(Err(_)) => return error(StatusCode::NOT_FOUND),
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR),
            _ => {}
        }
        if Instant::now() >= deadline {
            return error(StatusCode::SERVICE_UNAVAILABLE);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
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
    let permit = match tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        readers().clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return error(StatusCode::SERVICE_UNAVAILABLE),
    };
    let Ok(root) = super::root_for_generation(&app.state::<GraphState>(), generation) else {
        return error(StatusCode::FORBIDDEN);
    };
    let name = receipt.name.clone();
    let body = if head {
        Ok(Vec::new())
    } else {
        tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
            let _permit = permit;
            let path = archive::safe_path(&root, &format!("assets/x/{name}"))?;
            let mut file = File::open(path)?;
            anyhow::ensure!(file.metadata()?.len() == receipt.bytes, "file-changed");
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![0; count as usize];
            file.read_exact(&mut bytes)?;
            Ok(bytes)
        })
        .await
        .unwrap_or_else(|error| Err(error.into()))
    };
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
