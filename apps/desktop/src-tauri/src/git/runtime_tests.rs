use std::fs;
use std::path::Path;

use git2::{IndexAddOption, Repository, RepositoryInitOptions};
use tempfile::tempdir;

use super::super::commit::commit_all;
use super::super::merge::merge_remote;
use super::super::remote;
use super::super::{setup, MAX_FILE_BYTES};

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let target = root.join(path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, bytes).unwrap();
}

fn init(root: &Path) -> Repository {
    Repository::init_opts(root, RepositoryInitOptions::new().initial_head("main")).unwrap()
}

/// Model a repository maintained by a different Git client, including files
/// that client chose to track despite Reflect's runtime ignore defaults.
fn foreign_commit(repo: &Repository) {
    let mut index = repo.index().unwrap();
    index.add_all(["*"], IndexAddOption::FORCE, None).unwrap();
    index.update_all(["*"], None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
    let parents: Vec<_> = parent.iter().collect();
    let signature = git2::Signature::now("Other client", "other@example.com").unwrap();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "Foreign change",
        &tree,
        &parents,
    )
    .unwrap();
}

fn assert_no_runtime(repo: &Repository) {
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree
        .iter()
        .all(|entry| !entry.name_bytes().eq_ignore_ascii_case(b".reflect")));
    let mut index = repo.index().unwrap();
    index.read(true).unwrap();
    assert!(index.iter().all(|entry| {
        !entry
            .path
            .split(|byte| *byte == b'/')
            .next()
            .unwrap()
            .eq_ignore_ascii_case(b".reflect")
    }));
}

#[test]
fn adopting_tracked_runtime_untracks_it_without_removing_local_chat_data() {
    let dir = tempdir().unwrap();
    let repo = init(dir.path());
    write(dir.path(), ".reflect/index.sqlite", b"old shared runtime");
    write(dir.path(), "notes/a.md", b"note\n");
    foreign_commit(&repo);
    write(
        dir.path(),
        ".reflect/index.sqlite",
        b"durable local chat history",
    );
    write(
        dir.path(),
        ".reflect/index.sqlite-wal",
        b"live sqlite writes",
    );

    setup(dir.path(), None, None).unwrap();
    let mut index = repo.index().unwrap();
    index.read(true).unwrap();
    assert!(index
        .get_path(Path::new(".reflect/index.sqlite"), 0)
        .is_none());
    commit_all(dir.path(), "Backup", MAX_FILE_BYTES).unwrap();

    assert_no_runtime(&repo);
    assert_eq!(
        fs::read(dir.path().join(".reflect/index.sqlite")).unwrap(),
        b"durable local chat history"
    );
    assert_eq!(
        fs::read(dir.path().join(".reflect/index.sqlite-wal")).unwrap(),
        b"live sqlite writes"
    );
    assert!(
        !commit_all(dir.path(), "Backup", MAX_FILE_BYTES)
            .unwrap()
            .committed
    );
}

#[test]
fn commits_exclude_prestaged_and_case_variant_runtime_without_ignore_files() {
    let dir = tempdir().unwrap();
    let repo = init(dir.path());
    write(dir.path(), ".ReFlEcT/index.sqlite", b"local private chat");
    write(dir.path(), "notes/a.md", b"note\n");
    let mut index = repo.index().unwrap();
    index.add_all(["*"], IndexAddOption::FORCE, None).unwrap();
    index.write().unwrap();

    commit_all(dir.path(), "Backup", MAX_FILE_BYTES).unwrap();

    assert_no_runtime(&repo);
    assert_eq!(
        fs::read(dir.path().join(".ReFlEcT/index.sqlite")).unwrap(),
        b"local private chat"
    );
}

#[test]
fn clone_never_restores_another_devices_runtime() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source");
    let repo = init(&source);
    write(
        &source,
        ".reflect/index.sqlite",
        b"remote device's chat history",
    );
    write(&source, "notes/a.md", b"portable note\n");
    foreign_commit(&repo);
    let target = dir.path().join("restored");

    remote::clone(source.to_str().unwrap(), &target, None).unwrap();

    assert!(!target.join(".reflect").exists());
    assert_eq!(
        fs::read(target.join("notes/a.md")).unwrap(),
        b"portable note\n"
    );
    assert_no_runtime(&Repository::open(&target).unwrap());
}

#[test]
fn fast_forward_excludes_remote_runtime_and_preserves_local_chat_bytes() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source");
    let repo = init(&source);
    write(&source, "notes/a.md", b"base\n");
    foreign_commit(&repo);
    let target = dir.path().join("target");
    let local = Repository::clone(source.to_str().unwrap(), &target).unwrap();
    write(&target, ".reflect/index.sqlite", b"local durable chat");
    write(
        &target,
        ".reflect/index.sqlite-wal",
        b"local uncheckpointed chat",
    );
    write(&source, ".reflect/index.sqlite", b"foreign runtime");
    write(&source, "notes/a.md", b"remote update\n");
    foreign_commit(&repo);

    remote::fetch(&target, None).unwrap();
    let outcome = merge_remote(&target).unwrap();

    assert_no_runtime(&local);
    assert_eq!(
        fs::read(target.join(".reflect/index.sqlite")).unwrap(),
        b"local durable chat"
    );
    assert_eq!(
        fs::read(target.join(".reflect/index.sqlite-wal")).unwrap(),
        b"local uncheckpointed chat"
    );
    assert_eq!(
        fs::read(target.join("notes/a.md")).unwrap(),
        b"remote update\n"
    );
    assert!(outcome
        .changed_files
        .iter()
        .all(|change| !change.path.starts_with(".reflect")));
}

#[test]
fn divergent_merge_ignores_runtime_conflicts_and_preserves_local_chat_bytes() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source");
    let repo = init(&source);
    write(&source, "notes/a.md", b"base\n");
    write(&source, ".reflect/index.sqlite", b"historical runtime");
    foreign_commit(&repo);
    let target = dir.path().join("target");
    let local = Repository::clone(source.to_str().unwrap(), &target).unwrap();
    write(&target, ".reflect/index.sqlite", b"local durable chat");
    write(&target, "notes/local.md", b"local note\n");
    commit_all(&target, "Local backup", MAX_FILE_BYTES).unwrap();
    write(
        &source,
        ".reflect/index.sqlite",
        b"different foreign runtime",
    );
    write(&source, "notes/a.md", b"remote update\n");
    foreign_commit(&repo);

    remote::fetch(&target, None).unwrap();
    let outcome = merge_remote(&target).unwrap();

    assert_no_runtime(&local);
    assert!(outcome.conflicted_paths.is_empty());
    assert_eq!(
        fs::read(target.join(".reflect/index.sqlite")).unwrap(),
        b"local durable chat"
    );
    assert_eq!(
        fs::read(target.join("notes/a.md")).unwrap(),
        b"remote update\n"
    );
    assert_eq!(
        fs::read(target.join("notes/local.md")).unwrap(),
        b"local note\n"
    );
}

#[test]
fn size_guard_withholds_already_staged_large_additions_and_updates() {
    let dir = tempdir().unwrap();
    let repo = init(dir.path());
    write(dir.path(), "assets/existing.bin", b"small");
    commit_all(dir.path(), "Base", MAX_FILE_BYTES).unwrap();
    write(dir.path(), "assets/existing.bin", b"too large to back up");
    write(dir.path(), "assets/new.bin", b"also too large to back up");
    let mut index = repo.index().unwrap();
    index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    write(dir.path(), "notes/a.md", b"note\n");

    let outcome = commit_all(dir.path(), "Backup", 10).unwrap();

    assert!(outcome.committed);
    assert_eq!(outcome.skipped_large_files.len(), 2);
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree.get_path(Path::new("assets/new.bin")).is_err());
    let entry = tree.get_path(Path::new("assets/existing.bin")).unwrap();
    assert_eq!(repo.find_blob(entry.id()).unwrap().content(), b"small");
    assert_eq!(
        fs::read(dir.path().join("assets/new.bin")).unwrap(),
        b"also too large to back up"
    );
    assert_eq!(
        fs::read(dir.path().join("assets/existing.bin")).unwrap(),
        b"too large to back up"
    );
}
