use super::resolve::resolve;
use crate::error::{AppError, AppResult as Result};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

// FIXME: let's make it simpler by merge VIDEO_MAX_BYTES and IMAGE_MAX_BYTES into a single constant MEDIA_MAX_BYTES which is 20 * 1024 * 1024; also some API/functions in this file can be simplified or removed if we don't need to distinguish between video and image anymore.
pub const VIDEO_MAX_BYTES: u64 = 30 * 1024 * 1024;
pub const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const POST_JSON_MAX_BYTES: usize = 1024 * 1024;
// Cache formats cover X's documented JPG/PNG/GIF/WEBP images and progressive MP4.
// https://docs.x.com/x-api/media/quickstart/best-practices
// X's delivered-media examples expose MP4 and HLS variants; HLS playlists/segments
// are intentionally outside this single-file archive's scope.
// https://docs.x.com/x-api/enterprise-gnip-2.0/fundamentals/data-dictionary
// The upload API also accepts BMP/TIFF, MOV/WebM, subtitles, and 3D assets, but
// upload acceptance does not establish that tweet CDN responses use those formats.
// We do not add them without a delivered-media sample and rendering support.
// https://docs.x.com/x-api/media/initialize-media-upload
// These are canonical cache suffixes selected from bytes: JPEG (including URLs
// ending in .jpeg) becomes .jpg; the source URL's extension is never a filter.
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
    reqwest::Url::parse(source).map_err(|error| AppError::parse(error.to_string()))?;
    Ok(Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn get_candidate_names(hash: &str) -> Result<Vec<String>> {
    if !valid_hash(hash) {
        return Err(AppError::parse("invalid-hash"));
    }
    Ok(MEDIA_EXTENSIONS
        .iter()
        .map(|ext| format!("url_sha256_{hash}.{ext}"))
        .collect())
}
/// Temporary writes stay outside the graph's synced assets directory.
pub fn temporary_directory(root: &Path) -> Result<PathBuf> {
    let directory = resolve(root, ".reflect/x-archive")?;
    fs::create_dir_all(&directory)?;
    resolve(root, ".reflect/x-archive")
}
pub fn atomic_json(root: &Path, relative: &str, value: &Value) -> Result<()> {
    let path = resolve(root, relative)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::parse("missing-parent"))?;
    fs::create_dir_all(parent)?;
    resolve(root, relative)?;
    let mut temporary = tempfile::NamedTempFile::new_in(temporary_directory(root)?)?;
    let bytes = serde_json::to_vec(value).map_err(|error| AppError::parse(error.to_string()))?;
    if bytes.len() > POST_JSON_MAX_BYTES {
        return Err(AppError::parse("payload-too-large"));
    }
    std::io::Write::write_all(&mut temporary, &bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_json(root: &Path, relative: &str) -> Result<Option<Value>> {
    let path = resolve(root, relative)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > POST_JSON_MAX_BYTES as u64 {
        return Err(AppError::parse("payload-too-large"));
    }
    Ok(Some(
        serde_json::from_reader(file).map_err(|error| AppError::parse(error.to_string()))?,
    ))
}
pub fn media_byte_limit(prefix: &[u8]) -> u64 {
    match infer::get(prefix) {
        Some(kind) if kind.mime_type() == "video/mp4" => VIDEO_MAX_BYTES,
        Some(_) => IMAGE_MAX_BYTES,
        None => VIDEO_MAX_BYTES.max(IMAGE_MAX_BYTES),
    }
}

pub fn sniff(path: &Path) -> Result<(String, String, u64)> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let bytes = metadata.len();
    if !metadata.is_file() || bytes == 0 {
        return Err(AppError::parse("invalid-file"));
    }
    if bytes > VIDEO_MAX_BYTES.max(IMAGE_MAX_BYTES) {
        return Err(AppError::parse("media-too-large"));
    }
    let mut prefix = vec![0; bytes.min(8192) as usize];
    file.read_exact(&mut prefix)?;
    if bytes > media_byte_limit(&prefix) {
        return Err(AppError::parse("media-too-large"));
    }
    let kind = infer::get(&prefix).ok_or_else(|| AppError::parse("unsupported-format"))?;
    let extension = match kind.mime_type() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => {
            if bytes > VIDEO_MAX_BYTES {
                return Err(AppError::parse("video-too-large"));
            }
            "mp4"
        }
        _ => return Err(AppError::parse("unsupported-format")),
    };
    Ok((extension.into(), kind.mime_type().into(), bytes))
}
pub fn find_cache(root: &Path, hash: &str) -> Result<Option<Receipt>> {
    for name in get_candidate_names(hash)? {
        let path = resolve(root, &format!("assets/x/{name}"))?;
        if !path.exists() {
            continue;
        }
        let Ok((_extension, mime, bytes)) = sniff(&path) else {
            continue;
        };
        // left on disk forever, and the re-download writes a second file next to it. Either delete
        // the mismatched candidate here or accept it under the sniffed mime (the name is only a
        // cache key).
        // The first valid candidate wins silently.
        return Ok(Some(Receipt { name, bytes, mime }));
    }
    Ok(None)
}

pub fn read_post(root: &Path, post_id: &str) -> Result<Option<Value>> {
    if !valid_id(post_id) {
        return Err(AppError::parse("invalid-post-id"));
    }
    let post = read_json(root, &format!("assets/x/post-{post_id}.json"))?;
    if let Some(post) = &post {
        let view = post_view(post)?;
        if view.data.id != post_id {
            return Err(AppError::parse("post-id-mismatch"));
        }
    }
    Ok(post)
}

#[derive(Deserialize)]
pub struct ArchiveView {
    pub data: PostView,
}
#[derive(Deserialize)]
pub struct PostView {
    pub id: String,
    #[serde(default)]
    author: AuthorView,
    #[serde(default)]
    media: Vec<MediaView>,
    quote: Option<Box<PostView>>,
}
#[derive(Default, Deserialize)]
struct AuthorView {
    avatar: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum MediaView {
    #[serde(rename = "photo")]
    Photo { url: String },
    #[serde(rename = "video", alias = "gif")]
    Video {
        poster: Option<String>,
        #[serde(default)]
        sources: Vec<SourceView>,
    },
}
#[derive(Deserialize)]
struct SourceView {
    #[serde(rename = "type")]
    mime: String,
    url: String,
}
pub fn post_view(post: &Value) -> Result<ArchiveView> {
    let view: ArchiveView =
        serde_json::from_value(post.clone()).map_err(|error| AppError::parse(error.to_string()))?;
    if !valid_id(&view.data.id)
        || view
            .data
            .quote
            .as_ref()
            .is_some_and(|quote| !valid_id(&quote.id))
    {
        return Err(AppError::parse("invalid-post-id"));
    }
    Ok(view)
}

/// Derive resource URLs from the canonical post data, including a quoted post.
pub fn media_urls(post: &Value) -> Result<Vec<String>> {
    let view = post_view(post)?;
    let mut urls = std::collections::BTreeSet::new();
    for entry in std::iter::once(&view.data).chain(view.data.quote.as_deref()) {
        if let Some(url) = &entry.author.avatar {
            urls.insert(url.clone());
        }
        for media in &entry.media {
            match media {
                MediaView::Photo { url } => {
                    urls.insert(url.clone());
                }
                MediaView::Video { poster, sources } => {
                    if let Some(poster) = poster {
                        urls.insert(poster.clone());
                    }
                    urls.extend(
                        sources
                            .iter()
                            .filter(|source| source.mime == "video/mp4")
                            .map(|source| source.url.clone()),
                    );
                }
            }
        }
    }
    Ok(urls.into_iter().collect())
}

pub fn resource_url(root: &Path, post_id: &str, hash: &str) -> Result<String> {
    if !valid_hash(hash) {
        return Err(AppError::parse("invalid-hash"));
    }
    let post = read_post(root, post_id)?.ok_or_else(|| AppError::not_found("missing-post"))?;
    media_urls(&post)?
        .into_iter()
        .find(|url| hash_url(url).is_ok_and(|value| value == hash))
        .ok_or_else(|| AppError::not_found("unknown-resource"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shares_completed_urls_and_ignores_invalid_cache_candidates() {
        let root = tempfile::tempdir().unwrap();
        let url = "https://pbs.twimg.com/media/shared?name=orig&format=png";
        let hash = hash_url(url).unwrap();
        let dir = root.path().join("assets/x");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("url_sha256_{hash}.jpg")), b"invalid").unwrap();
        let name = format!("url_sha256_{hash}.png");
        std::fs::write(dir.join(&name), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        assert_eq!(find_cache(root.path(), &hash).unwrap().unwrap().name, name);
        for id in ["123", "456"] {
            let post = json!({ "data": { "id": id, "author": { "avatar": url } } });
            atomic_json(root.path(), &format!("assets/x/post-{id}.json"), &post).unwrap();
            assert_eq!(resource_url(root.path(), id, &hash).unwrap(), url);
        }
    }

    #[test]
    fn rejects_unowned_resources_and_unsafe_paths() {
        let root = tempfile::tempdir().unwrap();
        let post = json!({"data":{"id":"123", "author":{"avatar":"https://pbs.twimg.com/a.png"}}});
        atomic_json(root.path(), "assets/x/post-123.json", &post).unwrap();
        assert!(resource_url(
            root.path(),
            "123",
            &hash_url("https://pbs.twimg.com/b.png").unwrap()
        )
        .is_err());
        assert!(read_post(root.path(), "../123").is_err());
        assert!(resolve(root.path(), "../outside").is_err());
        let file = std::fs::read_to_string(root.path().join("assets/x/post-123.json")).unwrap();
        assert_eq!(file, serde_json::to_string(&post).unwrap());
    }

    #[test]
    fn includes_quote_media_and_excludes_hls_sources() {
        let post = json!({"data": {"id":"123", "quote": {"id":"456", "media": [{"type":"video", "poster":"https://pbs.twimg.com/p.jpg", "sources":[
            {"type":"video/mp4", "url":"https://video.twimg.com/v.mp4"},
            {"type":"application/x-mpegURL", "url":"https://video.twimg.com/v.m3u8"}
        ]}]}}});
        assert_eq!(
            media_urls(&post).unwrap(),
            vec![
                "https://pbs.twimg.com/p.jpg",
                "https://video.twimg.com/v.mp4"
            ]
        );
    }

    #[test]
    fn detects_video_bounds_from_bytes_without_trusting_content_type() {
        assert_eq!(media_byte_limit(b"\0\0\0\x18ftypmp42"), VIDEO_MAX_BYTES);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"\0\0\0\x18ftypmp42").unwrap();
        file.as_file().set_len(VIDEO_MAX_BYTES + 1).unwrap();
        assert!(sniff(file.path()).is_err());
    }

    #[test]
    fn retains_ownership_of_media_marked_unavailable() {
        let post = json!({"data": {"id":"123", "media": [{"type":"photo", "unavailable":true, "url":"https://pbs.twimg.com/private.jpg"}]}});
        assert_eq!(
            media_urls(&post).unwrap(),
            vec!["https://pbs.twimg.com/private.jpg"]
        );
    }
    #[test]
    fn accepts_sniffed_mime_even_when_cache_extension_differs() {
        let root = tempfile::tempdir().unwrap();
        let hash = hash_url("https://pbs.twimg.com/a").unwrap();
        let directory = root.path().join("assets/x");
        fs::create_dir_all(&directory).unwrap();
        let name = format!("url_sha256_{hash}.jpg");
        fs::write(directory.join(&name), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let receipt = find_cache(root.path(), &hash).unwrap().unwrap();
        assert_eq!(receipt.name, name);
        assert_eq!(receipt.mime, "image/png");
    }

    #[test]
    fn temporary_writes_are_private_and_json_limits_apply_on_write_and_read() {
        let root = tempfile::tempdir().unwrap();
        let directory = temporary_directory(root.path()).unwrap();
        assert_eq!(directory, root.path().join(".reflect/x-archive"));
        let value = json!({"data":{"id":"123"}});
        atomic_json(root.path(), "assets/x/post-123.json", &value).unwrap();
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(root.path().join("assets/x")).unwrap().count(),
            1
        );
        let huge = json!({"padding": "x".repeat(POST_JSON_MAX_BYTES)});
        assert!(matches!(
            atomic_json(root.path(), "assets/x/post-123.json", &huge),
            Err(AppError::Parse { .. })
        ));
        assert_eq!(read_post(root.path(), "123").unwrap(), Some(value));
        fs::write(
            root.path().join("assets/x/post-456.json"),
            vec![b' '; POST_JSON_MAX_BYTES + 1],
        )
        .unwrap();
        assert!(matches!(
            read_post(root.path(), "456"),
            Err(AppError::Parse { .. })
        ));
    }

    #[test]
    fn malformed_archives_return_parse_errors_and_missing_resources_return_not_found() {
        assert!(matches!(
            post_view(&json!({"data":{"id":"123", "media":[{"type":"photo"}]}})),
            Err(AppError::Parse { .. })
        ));
        assert!(matches!(
            post_view(&json!({"data":{"id":"../123"}})),
            Err(AppError::Parse { .. })
        ));
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            read_post(root.path(), "../123"),
            Err(AppError::Parse { .. })
        ));
        assert!(matches!(
            resolve(root.path(), "../outside"),
            Err(AppError::Traversal { .. })
        ));
        assert!(matches!(
            resource_url(root.path(), "123", &"a".repeat(64)),
            Err(AppError::NotFound { .. })
        ));
    }
    #[test]
    fn video_without_optional_poster_still_has_a_downloadable_source() {
        let post = json!({"data":{"id":"123","media":[{"type":"video","sources":[{"type":"video/mp4","url":"https://video.twimg.com/v.mp4"}]}]}});
        assert_eq!(
            media_urls(&post).unwrap(),
            vec!["https://video.twimg.com/v.mp4"]
        );
    }
    #[test]
    fn allows_thirty_mib_video_and_twenty_mib_images() {
        for (prefix, limit) in [
            (b"\0\0\0\x18ftypmp42".as_slice(), VIDEO_MAX_BYTES),
            (b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".as_slice(), IMAGE_MAX_BYTES),
        ] {
            let file = tempfile::NamedTempFile::new().unwrap();
            fs::write(file.path(), prefix).unwrap();
            file.as_file().set_len(limit).unwrap();
            assert_eq!(sniff(file.path()).unwrap().2, limit);
            file.as_file().set_len(limit + 1).unwrap();
            assert!(sniff(file.path()).is_err());
        }
        assert_eq!(media_byte_limit(b""), VIDEO_MAX_BYTES);
        assert_eq!(media_byte_limit(b"\0\0"), VIDEO_MAX_BYTES);
    }
}
