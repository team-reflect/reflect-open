use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
pub const VIDEO_MAX_BYTES: u64 = 10_000_000;
pub const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const POST_JSON_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const MEDIA_EXTENSIONS: &[&str] = &["jpg", "png", "webp", "gif", "mp4"];

#[derive(Clone, Debug)]
pub struct Receipt {
    pub name: String,
    pub bytes: u64,
    pub mime: String,
}

pub fn valid_id(id: &str) -> bool {
    !id.starts_with('0')
        && !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|b| b.is_ascii_digit())
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn hash_url(source: &str) -> Result<String> {
    reqwest::Url::parse(source)?;
    Ok(Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn get_candidate_names(hash: &str) -> Result<Vec<String>> {
    ensure!(valid_hash(hash), "invalid-hash");
    Ok(MEDIA_EXTENSIONS
        .iter()
        .map(|ext| format!("url_sha256_{hash}.{ext}"))
        .collect())
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(root.is_absolute() && root.is_dir(), "invalid-root");
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            bail!("invalid-path")
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) => ensure!(!meta.file_type().is_symlink(), "symlink"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}
pub fn atomic_json(root: &Path, relative: &str, value: &Value) -> Result<()> {
    let path = safe_path(root, relative)?;
    let parent = path.parent().context("parent")?;
    fs::create_dir_all(parent)?;
    safe_path(root, relative)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_json(root: &Path, relative: &str) -> Result<Option<Value>> {
    let path = safe_path(root, relative)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        file.metadata()?.len() <= POST_JSON_MAX_BYTES as u64,
        "payload-too-large"
    );
    Ok(Some(serde_json::from_reader(file)?))
}
pub fn media_byte_limit(prefix: &[u8]) -> u64 {
    if infer::get(prefix).is_some_and(|kind| kind.mime_type() == "video/mp4") {
        VIDEO_MAX_BYTES
    } else {
        IMAGE_MAX_BYTES
    }
}

pub fn sniff(path: &Path) -> Result<(String, String, u64)> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let bytes = metadata.len();
    ensure!(metadata.is_file() && bytes > 0, "invalid-file");
    ensure!(bytes <= IMAGE_MAX_BYTES, "media-too-large");
    let mut prefix = vec![0; bytes.min(8192) as usize];
    file.read_exact(&mut prefix)?;
    let kind = infer::get(&prefix).context("unsupported-format")?;
    let extension = match kind.mime_type() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => {
            ensure!(bytes <= VIDEO_MAX_BYTES, "video-too-large");
            "mp4"
        }
        _ => bail!("unsupported-format"),
    };
    Ok((extension.into(), kind.mime_type().into(), bytes))
}
pub fn find_cache(root: &Path, hash: &str) -> Result<Option<Receipt>> {
    for name in get_candidate_names(hash)? {
        let path = safe_path(root, &format!("assets/x/{name}"))?;
        if !path.exists() {
            continue;
        }
        let Ok((extension, mime, bytes)) = sniff(&path) else {
            continue;
        };
        if !name.ends_with(&format!(".{extension}")) {
            continue;
        }
        // The first valid candidate wins silently.
        return Ok(Some(Receipt { name, bytes, mime }));
    }
    Ok(None)
}

pub fn read_post(root: &Path, post_id: &str) -> Result<Option<Value>> {
    ensure!(valid_id(post_id), "invalid-post-id");
    let post = read_json(root, &format!("assets/x/post-{post_id}.json"))?;
    if let Some(post) = &post {
        ensure!(post["data"].is_object(), "invalid-post");
    }
    Ok(post)
}

/// Derive resource URLs from the canonical post data, including a quoted post.
pub fn media_urls(post: &Value) -> Vec<String> {
    let mut urls = std::collections::BTreeSet::new();
    for entry in [&post["data"], &post["data"]["quote"]] {
        if let Some(url) = entry["author"]["avatar"].as_str() {
            urls.insert(url.to_owned());
        }
        for media in entry["media"].as_array().into_iter().flatten() {
            if media["type"] == "photo" {
                if let Some(url) = media["url"].as_str() {
                    urls.insert(url.to_owned());
                }
            } else {
                if let Some(url) = media["poster"].as_str() {
                    urls.insert(url.to_owned());
                }
                for source in media["sources"].as_array().into_iter().flatten() {
                    if source["type"] == "video/mp4" {
                        if let Some(url) = source["url"].as_str() {
                            urls.insert(url.to_owned());
                        }
                    }
                }
            }
        }
    }
    urls.into_iter().collect()
}

pub fn resource_url(root: &Path, post_id: &str, hash: &str) -> Result<String> {
    ensure!(valid_hash(hash), "invalid-hash");
    let post = read_post(root, post_id)?.context("missing-post")?;
    media_urls(&post)
        .into_iter()
        .find(|url| hash_url(url).is_ok_and(|value| value == hash))
        .context("unknown-resource")
}

#[cfg(test)]
mod archive {
    use super as archive;
    use serde_json::json;

    #[test]
    fn shares_completed_urls_and_ignores_invalid_cache_candidates() {
        let root = tempfile::tempdir().unwrap();
        let url = "https://pbs.twimg.com/media/shared?name=orig&format=png";
        let hash = archive::hash_url(url).unwrap();
        let dir = root.path().join("assets/x");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("url_sha256_{hash}.jpg")), b"invalid").unwrap();
        let name = format!("url_sha256_{hash}.png");
        std::fs::write(dir.join(&name), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        assert_eq!(
            archive::find_cache(root.path(), &hash)
                .unwrap()
                .unwrap()
                .name,
            name
        );
        for id in ["123", "456"] {
            let post = json!({ "data": { "id": id, "author": { "avatar": url } } });
            archive::atomic_json(root.path(), &format!("assets/x/post-{id}.json"), &post).unwrap();
            assert_eq!(archive::resource_url(root.path(), id, &hash).unwrap(), url);
        }
    }

    #[test]
    fn rejects_unowned_resources_and_unsafe_paths() {
        let root = tempfile::tempdir().unwrap();
        let post = json!({"data":{"id":"123", "author":{"avatar":"https://pbs.twimg.com/a.png"}}});
        archive::atomic_json(root.path(), "assets/x/post-123.json", &post).unwrap();
        assert!(archive::resource_url(
            root.path(),
            "123",
            &archive::hash_url("https://pbs.twimg.com/b.png").unwrap()
        )
        .is_err());
        assert!(archive::read_post(root.path(), "../123").is_err());
        assert!(archive::safe_path(root.path(), "../outside").is_err());
        let file = std::fs::read_to_string(root.path().join("assets/x/post-123.json")).unwrap();
        assert_eq!(file, serde_json::to_string(&post).unwrap());
    }

    #[test]
    fn includes_quote_media_and_excludes_hls_sources() {
        let post = json!({"data": {"quote": {"media": [{"type":"video", "poster":"https://pbs.twimg.com/p.jpg", "sources":[
            {"type":"video/mp4", "url":"https://video.twimg.com/v.mp4"},
            {"type":"application/x-mpegURL", "url":"https://video.twimg.com/v.m3u8"}
        ]}]}}});
        assert_eq!(
            archive::media_urls(&post),
            vec![
                "https://pbs.twimg.com/p.jpg",
                "https://video.twimg.com/v.mp4"
            ]
        );
    }

    #[test]
    fn detects_video_bounds_from_bytes_without_trusting_content_type() {
        assert_eq!(
            archive::media_byte_limit(b"\0\0\0\x18ftypmp42"),
            archive::VIDEO_MAX_BYTES
        );
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"\0\0\0\x18ftypmp42").unwrap();
        file.as_file()
            .set_len(archive::VIDEO_MAX_BYTES + 1)
            .unwrap();
        assert!(archive::sniff(file.path()).is_err());
    }

    #[test]
    fn retains_ownership_of_media_marked_unavailable() {
        let post = json!({"data": {"media": [{"type":"photo", "unavailable":true, "url":"https://pbs.twimg.com/private.jpg"}]}});
        assert_eq!(
            archive::media_urls(&post),
            vec!["https://pbs.twimg.com/private.jpg"]
        );
    }
}
