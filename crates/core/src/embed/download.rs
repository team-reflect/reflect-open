//! Downloads the model file: resumes a partial download with an HTTP `Range`
//! request, and checks the SHA-256 before the file gets its final name.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

/// One file to fetch, pinned by size and hash.
pub(super) struct Download<'a> {
    pub url: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

/// Fetches `download` into `dest`, calling `progress` with the bytes on disk.
/// The partial file `<dest>.part` stays between attempts, so a retry resumes
/// it. A mismatched hash deletes it, so the next attempt starts over.
pub(super) async fn fetch(
    download: &Download<'_>,
    dest: &Path,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = dest.with_added_extension("part");
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|err| format!("creating {}: {err}", dir.display()))?;
    }
    // A partial file larger than the model is damaged: start over.
    let mut have = tokio::fs::metadata(&part)
        .await
        .ok()
        .map(|meta| meta.len())
        .filter(|&len| len <= download.size)
        .unwrap_or(0);
    progress(have);
    if have < download.size {
        // No total timeout: a slow connection may take many minutes for the model.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|err| err.to_string())?;
        let mut request = client.get(download.url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut response = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| err.to_string())?;
        // A server that ignores the range sends the whole file.
        let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !resumed {
            have = 0;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .await
            .map_err(|err| format!("opening {}: {err}", part.display()))?;
        while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
            have += chunk.len() as u64;
            if have > download.size {
                return Err(format!("download is larger than {} bytes", download.size));
            }
            file.write_all(&chunk)
                .await
                .map_err(|err| format!("writing {}: {err}", part.display()))?;
            progress(have);
        }
        file.sync_all()
            .await
            .map_err(|err| format!("writing {}: {err}", part.display()))?;
        if have != download.size {
            return Err(format!(
                "download ended at {have} of {} bytes",
                download.size
            ));
        }
    }

    let hashed = part.clone();
    let actual = tokio::task::spawn_blocking(move || sha256_file(&hashed))
        .await
        .map_err(|err| format!("hashing task panicked: {err}"))??;
    if actual != download.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "sha256 mismatch: expected {}, got {actual}",
            download.sha256
        ));
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|err| format!("renaming {}: {err}", part.display()))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|err| format!("opening {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(reflect_utils::hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const BODY: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

    static BODY_SHA256: LazyLock<String> = LazyLock::new(|| reflect_utils::sha256_hex(BODY));

    fn download(url: &str) -> Download<'_> {
        Download {
            url,
            size: BODY.len() as u64,
            sha256: &BODY_SHA256,
        }
    }

    /// Answers one request with `BODY` and returns the request. With `ranges`,
    /// `Range: bytes=N-` gets a 206 with the tail; otherwise the answer is 200.
    async fn serve_once(ranges: bool) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model.gguf", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 4096];
            let read = stream.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
            let start = request
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .and_then(|range| range.trim_end_matches('-').parse::<usize>().ok())
                .filter(|_| ranges);
            let (status, body) = match start {
                Some(start) => ("206 Partial Content", &BODY[start..]),
                None => ("200 OK", BODY),
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
            request
        });
        (url, task)
    }

    #[tokio::test]
    async fn fetches_and_verifies_the_whole_file() {
        let (url, server) = serve_once(true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("models/model.gguf");
        let mut reported = Vec::new();
        fetch(&download(&url), &dest, |bytes| reported.push(bytes))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert!(!dest.with_added_extension("part").exists());
        assert_eq!(reported.last(), Some(&(BODY.len() as u64)));
        assert!(!server.await.unwrap().contains("range:"));
    }

    #[tokio::test]
    async fn resumes_a_partial_file_with_a_range_request() {
        let (url, server) = serve_once(true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(dest.with_added_extension("part"), &BODY[..10]).unwrap();
        fetch(&download(&url), &dest, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert!(server.await.unwrap().contains("range: bytes=10-"));
    }

    #[tokio::test]
    async fn starts_over_when_the_server_ignores_the_range() {
        let (url, _server) = serve_once(false).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(dest.with_added_extension("part"), b"garbage!!!").unwrap();
        fetch(&download(&url), &dest, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }

    #[tokio::test]
    async fn deletes_the_partial_file_on_a_hash_mismatch() {
        let (url, _server) = serve_once(true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        let wrong = Download {
            sha256: "00",
            ..download(&url)
        };
        let err = fetch(&wrong, &dest, |_| {}).await.unwrap_err();
        assert!(err.starts_with("sha256 mismatch"), "{err}");
        assert!(!dest.exists());
        assert!(!dest.with_added_extension("part").exists());
    }

    #[tokio::test]
    async fn skips_the_request_when_the_partial_file_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(dest.with_added_extension("part"), BODY).unwrap();
        let unreachable = download("http://127.0.0.1:9/model.gguf");
        fetch(&unreachable, &dest, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }
}
