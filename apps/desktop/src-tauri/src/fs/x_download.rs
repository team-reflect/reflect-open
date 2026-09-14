use super::x_archive_store as archive;
use anyhow::{ensure, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// Share downloads by graph and exact URL, including across different posts.
// FIXME(rust): the Weak-map plus `retain` scan on every call is O(live entries) per download and
// exists only to evict finished locks. Entries are bounded by distinct media URLs seen in one
// session; a plain `Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>` without eviction is
// simpler, or evict the entry when the download completes. Fold this into the shared-outcome change
// suggested at `lock.lock().await` below.
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
    // FIXME(logic): waiters queue serially behind this mutex and each one retries the download
    // after the previous attempt failed (`find_cache` is still empty). Twenty cards sharing one
    // avatar on a flaky network serialize twenty attempts of up to 180s each, and every
    // reflect-asset request for that avatar stays pending meanwhile. Share the outcome with the
    // waiters instead: keep a per-hash `tokio::sync::OnceCell<Result<Receipt>>`-style entry (or
    // record a short-lived failure) so one failure answers all of them and a retry only happens on
    // the next resolve.
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
    // FIXME(logic): this `.part-*` temp file (and the `.tmp*` file `atomic_json` creates) lives
    // inside `assets/x/`, i.e. inside the synced graph. The graph `.gitignore` defaults only cover
    // `/.reflect/`, `.DS_Store` and editor swap files, and `git/commit.rs` stages with
    // `add_all("*")`, so an auto-commit that races a download commits a half-written file, iCloud
    // uploads it, and a crash mid-download leaves it behind forever (nothing sweeps `assets/x`).
    // Write temps under `.reflect/x-archive/` (gitignored, invisible to the watcher, same
    // filesystem so `persist` is still an atomic rename into `assets/x`), or add `.part-*`/`.tmp*`
    // to the gitignore defaults and sweep stale temps at startup. The duplicated `safe_path(&root,
    // "assets/x")` call above goes with it.
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
    fn shares_download_locks_by_graph_and_url() {
        let first = download_lock(Path::new("/graph-a"), "url-a");
        assert!(Arc::ptr_eq(
            &first,
            &download_lock(Path::new("/graph-a"), "url-a")
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &download_lock(Path::new("/graph-b"), "url-a")
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &download_lock(Path::new("/graph-a"), "url-b")
        ));
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
