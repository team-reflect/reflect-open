use anyhow::{ensure, Context, Result};
use reflect_x_archive as archive;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// Share downloads by graph and exact URL, including across different posts.
fn download_lock(root: &Path, hash: &str) -> Arc<tokio::sync::Mutex<()>> {
    type Locks = Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("download locks");
    locks.retain(|_, lock| lock.strong_count() > 0);
    let entry = locks.entry(root.join(hash)).or_default();
    if let Some(lock) = entry.upgrade() {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    *entry = Arc::downgrade(&lock);
    lock
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
    let lock = download_lock(&root, &hash);
    let _guard = lock.lock().await;
    let cache_root = root.clone();
    let cache_hash = hash.clone();
    if let Some(receipt) =
        tauri::async_runtime::spawn_blocking(move || archive::find_cache(&cache_root, &cache_hash))
            .await??
    {
        return Ok(receipt);
    }
    let remote = reqwest::Url::parse(&url)?;
    ensure!(allowed(&remote), "unsupported-media-url");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed(attempt.url()) {
                attempt.error("unsupported-media-redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    let mut response = client.get(remote).send().await?.error_for_status()?;
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
    ensure!(
        response.content_length().is_none_or(|bytes| bytes <= limit),
        "media-too-large"
    );
    let directory = archive::safe_path(&root, "assets/x")?;
    tokio::fs::create_dir_all(&directory).await?;
    archive::safe_path(&root, "assets/x")?;
    let temporary = tempfile::Builder::new()
        .prefix(".part-")
        .tempfile_in(&directory)?;
    let mut file = tokio::fs::File::from_std(temporary.reopen()?);
    let mut bytes = 0u64;
    let mut prefix = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        prefix.extend_from_slice(&chunk[..chunk.len().min(8192 - prefix.len())]);
        limit = limit.min(archive::media_byte_limit(&prefix));
        bytes += chunk.len() as u64;
        ensure!(bytes <= limit, "media-too-large");
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    drop(file);
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, mime, bytes) = archive::sniff(temporary.path())?;
        let name = format!("url_sha256_{hash}.{extension}");
        let path = archive::safe_path(&root, &format!("assets/x/{name}"))?;
        temporary.persist(path).map_err(|error| error.error)?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok(archive::Receipt { name, mime, bytes })
    })
    .await
    .context("download publish task")?
}
