use reflect_x_archive as archive;
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
    assert!(
        archive::resource_url(
            root.path(),
            "123",
            &archive::hash_url("https://pbs.twimg.com/b.png").unwrap()
        )
        .is_err()
    );
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
