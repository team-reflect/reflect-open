//! Downloads the model file: resumes a partial download with an HTTP `Range`
//! request, and checks the SHA-256 before the file gets its final name.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

/// One file to fetch, pinned by size and hash.
pub(super) struct Download<'a> {
    pub url: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

/// The partial file next to `dest`, kept between attempts so a retry resumes.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Fetches `download` into `dest`, calling `progress` with the bytes on disk.
/// A mismatched hash deletes the partial file, so the next attempt starts over.
pub(super) async fn fetch(
    download: &Download<'_>,
    dest: &Path,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = part_path(dest);
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|err| format!("creating {}: {err}", dir.display()))?;
    }
    let mut have = tokio::fs::metadata(&part)
        .await
        .map_or(0, |meta| meta.len());
    if have > download.size {
        have = 0;
    }
    if have < download.size {
        have = fetch_range(download, &part, have, &mut progress).await?;
    }
    if have != download.size {
        return Err(format!(
            "download ended at {have} of {} bytes",
            download.size
        ));
    }
    progress(have);

    let expected = download.sha256.to_owned();
    let hashed = part.clone();
    let actual = tokio::task::spawn_blocking(move || sha256_file(&hashed))
        .await
        .map_err(|err| format!("hashing task panicked: {err}"))??;
    if actual != expected {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "sha256 mismatch: expected {expected}, got {actual}"
        ));
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|err| format!("renaming {}: {err}", part.display()))
}

/// Appends the bytes from `have` on to `part`, or rewrites it when the server
/// ignores the range. Returns the bytes on disk.
async fn fetch_range(
    download: &Download<'_>,
    part: &Path,
    mut have: u64,
    progress: &mut impl FnMut(u64),
) -> Result<u64, String> {
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
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed {
        have = 0;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part)
        .await
        .map_err(|err| format!("opening {}: {err}", part.display()))?;
    progress(have);
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
    Ok(have)
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
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const BODY: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

    static BODY_SHA256: LazyLock<String> = LazyLock::new(|| {
        Sha256::digest(BODY)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    });

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
        assert!(!part_path(&dest).exists());
        assert_eq!(reported.last(), Some(&(BODY.len() as u64)));
        assert!(!server.await.unwrap().contains("range:"));
    }

    #[tokio::test]
    async fn resumes_a_partial_file_with_a_range_request() {
        let (url, server) = serve_once(true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(part_path(&dest), &BODY[..10]).unwrap();
        fetch(&download(&url), &dest, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert!(server.await.unwrap().contains("range: bytes=10-"));
    }

    #[tokio::test]
    async fn starts_over_when_the_server_ignores_the_range() {
        let (url, _server) = serve_once(false).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(part_path(&dest), b"garbage!!!").unwrap();
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
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn skips_the_request_when_the_partial_file_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.gguf");
        std::fs::write(part_path(&dest), BODY).unwrap();
        let unreachable = download("http://127.0.0.1:9/model.gguf");
        fetch(&unreachable, &dest, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }
}
