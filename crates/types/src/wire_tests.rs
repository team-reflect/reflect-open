//! Pins the JSON shapes the frontend's zod schemas expect.

use serde_json::json;

use crate::{AppError, FileChange, FileMeta};

#[test]
fn app_error_serializes_as_kind_and_message() {
    let error = AppError::Io {
        message: "disk full".into(),
        git_code: Some(-14),
    };
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({ "kind": "io", "message": "disk full" })
    );
    assert_eq!(
        serde_json::to_value(AppError::no_graph()).unwrap(),
        json!({ "kind": "noGraph", "message": "No graph is open" })
    );
}

#[test]
fn file_change_omits_a_missing_mtime() {
    assert_eq!(
        serde_json::to_value(FileChange::upsert("notes/a.md", Some(7))).unwrap(),
        json!({ "path": "notes/a.md", "kind": "upsert", "modifiedMs": 7 })
    );
    assert_eq!(
        serde_json::to_value(FileChange::remove("notes/a.md")).unwrap(),
        json!({ "path": "notes/a.md", "kind": "remove" })
    );
}

#[test]
fn file_meta_omits_a_false_placeholder() {
    let meta = FileMeta {
        path: "notes/a.md".into(),
        size: 3,
        modified_ms: 9,
        placeholder: false,
    };
    assert_eq!(
        serde_json::to_value(&meta).unwrap(),
        json!({ "path": "notes/a.md", "size": 3, "modifiedMs": 9 })
    );
}
