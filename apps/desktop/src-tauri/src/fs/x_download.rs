use super::x_archive_store as archive;
use crate::error::{AppError, AppResult as Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

type Download = tokio::sync::OnceCell<Result<archive::Receipt>>;
type Downloads = Mutex<HashMap<PathBuf, Arc<Download>>>;
fn downloads() -> &'static Downloads {
    static DOWNLOADS: OnceLock<Downloads> = OnceLock::new();
    DOWNLOADS.get_or_init(Default::default)
}

/// Concurrent callers share success and failure. A later request may retry.
async fn shared_download(
    key: PathBuf,
    action: impl std::future::Future<Output = Result<archive::Receipt>>,
) -> Result<archive::Receipt> {
    let entry = downloads()
        .lock()
        .expect("downloads")
        .entry(key.clone())
        .or_default()
        .clone();
    let result = entry.get_or_init(|| action).await.clone();
    let mut pending = downloads().lock().expect("downloads");
    if pending
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &entry))
    {
        pending.remove(&key);
    }
    result
}

fn network(error: reqwest::Error) -> AppError {
    AppError::Network {
        message: error.to_string(),
    }
}

fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("pbs.twimg.com" | "video.twimg.com"))
}

/// Start or join one download. Only the final validated file is visible in assets/x.
pub async fn download(root: PathBuf, url: String) -> Result<archive::Receipt> {
    let hash = archive::hash_url(&url)?;
    shared_download(root.join(&hash), download_once(root, url, hash)).await
}

async fn download_once(root: PathBuf, url: String, hash: String) -> Result<archive::Receipt> {
    let cache_root = root.clone();
    let cache_hash = hash.clone();
    if let Some(receipt) =
        tauri::async_runtime::spawn_blocking(move || archive::find_cache(&cache_root, &cache_hash))
            .await
            .map_err(|error| AppError::io(error.to_string()))??
    {
        return Ok(receipt);
    }
    let remote = reqwest::Url::parse(&url).map_err(|error| AppError::parse(error.to_string()))?;
    if !allowed(&remote) {
        return Err(AppError::parse("unsupported-media-url"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed(attempt.url()) {
                attempt.error("unsupported-media-redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(network)?;
    let mut response = client
        .get(remote)
        .send()
        .await
        .map_err(network)?
        .error_for_status()
        .map_err(network)?;
    let mut limit = if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .is_some_and(|mime| mime.starts_with("video/mp4"))
    {
        archive::VIDEO_MAX_BYTES
    } else {
        archive::IMAGE_MAX_BYTES
    };
    if response.content_length().is_some_and(|bytes| bytes > limit) {
        return Err(AppError::parse("media-too-large"));
    }
    let directory = super::resolve::resolve(&root, "assets/x")?;
    tokio::fs::create_dir_all(&directory).await?;

    let temporary = tempfile::Builder::new()
        .prefix(".part-")
        .tempfile_in(archive::temporary_directory(&root)?)?;
    let mut file = tokio::fs::File::from_std(temporary.reopen()?);
    let mut bytes = 0u64;
    let mut prefix = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        prefix.extend_from_slice(&chunk[..chunk.len().min(8192 - prefix.len())]);
        limit = limit.min(archive::media_byte_limit(&prefix));
        bytes += chunk.len() as u64;
        if bytes > limit {
            return Err(AppError::parse("media-too-large"));
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    drop(file);
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, mime, bytes) = archive::sniff(temporary.path())?;
        let name = format!("url_sha256_{hash}.{extension}");
        let path = super::resolve::resolve(&root, &format!("assets/x/{name}"))?;
        temporary.persist(path).map_err(|error| error.error)?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok(archive::Receipt { name, mime, bytes })
    })
    .await
    .map_err(|error| AppError::io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_downloads_to_anonymous_https_cdn_urls() {
        for url in [
            "https://pbs.twimg.com/a.png",
            "https://video.twimg.com/a.mp4",
        ] {
            assert!(allowed(&reqwest::Url::parse(url).unwrap()));
        }
        for url in [
            "http://pbs.twimg.com/a.png",
            "https://pbs.twimg.com.evil.test/a.png",
            "https://user:password@pbs.twimg.com/a.png",
            "https://pbs.twimg.com:444/a.png",
            "https://127.0.0.1/a.png",
        ] {
            assert!(!allowed(&reqwest::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn concurrent_callers_share_failure_and_later_calls_retry() {
        tauri::async_runtime::block_on(async {
            let key = tempfile::tempdir().unwrap();
            let key = key.path().join("shared-failure");
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let release = Arc::new(tokio::sync::Notify::new());
            let mut tasks = Vec::new();
            for _ in 0..20 {
                let key = key.clone();
                let calls = calls.clone();
                let release = release.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    shared_download(key, async {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        release.notified().await;
                        Err(AppError::Network {
                            message: "offline".into(),
                        })
                    })
                    .await
                }));
            }
            // Wait until every caller owns the same pending entry before releasing it.
            loop {
                let ready = downloads()
                    .lock()
                    .unwrap()
                    .get(&key)
                    .is_some_and(|entry| Arc::strong_count(entry) == 21);
                if ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
            release.notify_one();
            for task in tasks {
                assert!(matches!(task.await.unwrap(), Err(AppError::Network { .. })));
            }
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(!downloads().lock().unwrap().contains_key(&key));
            let _ = shared_download(key, async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(AppError::Network {
                    message: "retry".into(),
                })
            })
            .await;
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn returns_completed_media_offline_without_requesting_the_source() {
        let root = tempfile::tempdir().unwrap();
        // A non-CDN URL could never be downloaded, but an existing valid cache is usable.
        let url = "https://offline.invalid/photo.png";
        let hash = archive::hash_url(url).unwrap();
        let directory = root.path().join("assets/x");
        std::fs::create_dir_all(&directory).unwrap();
        let name = format!("url_sha256_{hash}.png");
        std::fs::write(directory.join(&name), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let receipt =
            tauri::async_runtime::block_on(download(root.path().to_owned(), url.into())).unwrap();
        assert_eq!(receipt.name, name);
        assert_eq!(receipt.mime, "image/png");
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    }
}
