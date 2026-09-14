use reflect_x_archive as archive;
use serde_json::json;
use sha2::{Digest, Sha256};

fn capture(root: &std::path::Path, id: &str, url: &str) -> serde_json::Value {
    let value = json!({"kind":"x-post","id":id,"revision":"one","data":{"id":id},
        "resources":[{"url":url,"state":"pending"}]});
    archive::put_capture(
        root,
        json!({"id":uuid::Uuid::new_v4().to_string(),
        "postId":id,"archive":value}),
    )
    .unwrap();
    assert!(archive::write_post(root, id, None, &value).unwrap());
    value
}

#[test]
fn shares_completed_url_across_posts_and_retries_commit() {
    let root = tempfile::tempdir().unwrap();
    let url = "https://pbs.twimg.com/media/shared?name=orig&format=png";
    capture(root.path(), "123", url);
    capture(root.path(), "456", url);
    let job = archive::pull(root.path()).unwrap().unwrap();
    assert_eq!(job.post_ids.len(), 2);
    assert!(archive::pull(root.path()).unwrap().is_none());
    let bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    let lease = job.lease.as_deref().unwrap();
    assert_eq!(
        archive::append(root.path(), &job.id, lease, 0, bytes).unwrap(),
        bytes.len() as u64
    );
    assert_eq!(
        archive::append(root.path(), &job.id, lease, 0, bytes).unwrap(),
        bytes.len() as u64
    );
    let checksum = format!("{:x}", Sha256::digest(bytes));
    let receipt =
        archive::commit(root.path(), &job.id, lease, bytes.len() as u64, &checksum).unwrap();
    assert_eq!(
        receipt.name,
        format!("url_sha256_{}.png", archive::hash_url(url).unwrap())
    );
    assert_eq!(
        archive::commit(root.path(), &job.id, lease, bytes.len() as u64, &checksum)
            .unwrap()
            .name,
        receipt.name
    );
    assert!(archive::pull(root.path()).unwrap().is_none());
    assert_eq!(
        archive::ensure_resource(root.path(), "456", &archive::hash_url(url).unwrap())
            .unwrap()
            .state,
        "stored"
    );
}

#[test]
fn rejects_unowned_resources_and_conflicting_revisions() {
    let root = tempfile::tempdir().unwrap();
    let post = capture(root.path(), "123", "https://example.com/image.png");
    assert!(!archive::write_post(root.path(), "123", None, &post).unwrap());
    assert!(
        archive::ensure_resource(
            root.path(),
            "123",
            &archive::hash_url("https://example.com/other.png").unwrap()
        )
        .is_err()
    );
    let file = std::fs::read_to_string(root.path().join("assets/x/post-123.json")).unwrap();
    assert_eq!(file, serde_json::to_string(&post).unwrap());
}

#[test]
fn invalid_complete_media_stays_terminal_after_restart() {
    let root = tempfile::tempdir().unwrap();
    capture(root.path(), "123", "https://example.com/not-media");
    let job = archive::pull(root.path()).unwrap().unwrap();
    let bytes = b"not a media file";
    let lease = job.lease.as_deref().unwrap();
    archive::append(root.path(), &job.id, lease, 0, bytes).unwrap();
    let checksum = format!("{:x}", Sha256::digest(bytes));
    assert!(archive::commit(root.path(), &job.id, lease, bytes.len() as u64, &checksum).is_err());
    assert_eq!(
        archive::status(root.path(), &job.id).unwrap().state,
        "unsupported"
    );
    assert!(archive::pull(root.path()).unwrap().is_none());
    assert!(
        !root
            .path()
            .join(format!(".reflect/x-archive/transfers/{}.part", job.id))
            .exists()
    );
}
