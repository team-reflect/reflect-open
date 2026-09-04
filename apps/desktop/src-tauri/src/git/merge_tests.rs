//! Regression coverage for dirty worktrees and failed pull application. Remote
//! changes are published to a local repository so every interleaving is explicit.

use std::fs;
use std::path::{Path, PathBuf};

use git2::{Oid, Repository, RepositoryInitOptions};
use tempfile::{tempdir, TempDir};

use super::commit::commit_all;
use super::merge::{merge_remote, MergeKind};

const LIMIT: u64 = 95 * 1024 * 1024;

struct Fixture {
    _directory: TempDir,
    origin: PathBuf,
    local: PathBuf,
}

fn write(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
    let target = root.join(path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, contents).unwrap();
}

fn commit(root: &Path) -> Oid {
    commit_all(root, "test changes", LIMIT).unwrap();
    head(root)
}

fn head(root: &Path) -> Oid {
    Repository::open(root)
        .unwrap()
        .refname_to_id("HEAD")
        .unwrap()
}

fn fixture() -> Fixture {
    let directory = tempdir().unwrap();
    let origin = directory.path().join("origin");
    Repository::init_opts(&origin, RepositoryInitOptions::new().initial_head("main")).unwrap();
    write(&origin, ".gitignore", "/.reflect/\n*.ignored\n");
    write(&origin, "notes/shared.md", "base\n");
    write(&origin, "assets/image.bin", b"base\0");
    commit(&origin);
    let local = directory.path().join("local");
    Repository::clone(origin.to_str().unwrap(), &local).unwrap();
    Fixture {
        _directory: directory,
        origin,
        local,
    }
}

fn fetch(root: &Path) {
    Repository::open(root)
        .unwrap()
        .find_remote("origin")
        .unwrap()
        .fetch(&["main"], None, None)
        .unwrap();
}

fn blob(root: &Path, commit_id: Oid, path: &str) -> Vec<u8> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.find_commit(commit_id).unwrap().tree().unwrap();
    let entry = tree.get_path(Path::new(path)).unwrap();
    let blob = repo.find_blob(entry.id()).unwrap();
    blob.content().to_vec()
}

#[test]
fn fast_forward_refuses_a_note_saved_during_fetch_without_moving_head() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote revision\n");
    commit(&fixture.origin);
    let original = commit(&fixture.local);
    let index = fs::read(fixture.local.join(".git/index")).unwrap();
    write(
        &fixture.local,
        "notes/shared.md",
        "autosave completed during fetch\n",
    );
    fetch(&fixture.local);

    assert!(merge_remote(&fixture.local).is_err());
    assert_eq!(head(&fixture.local), original);
    assert_eq!(fs::read(fixture.local.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(fixture.local.join("notes/shared.md")).unwrap(),
        "autosave completed during fetch\n"
    );
}

#[test]
fn committing_saves_after_fetch_merges_both_versions_and_retains_the_saved_parent() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote revision\n");
    let remote = commit(&fixture.origin);
    commit(&fixture.local);
    write(&fixture.local, "notes/shared.md", "saved during fetch\n");
    fetch(&fixture.local);
    let saved = commit(&fixture.local);

    let outcome = merge_remote(&fixture.local).unwrap();
    assert!(matches!(outcome.kind, MergeKind::MergedWithConflicts));
    let content = fs::read_to_string(fixture.local.join("notes/shared.md")).unwrap();
    assert!(
        content.contains("<<<<<<< this device\nsaved during fetch\n"),
        "{content}"
    );
    assert!(
        content.contains("remote revision\n>>>>>>> other device"),
        "{content}"
    );
    let repo = Repository::open(&fixture.local).unwrap();
    let merged = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(merged.parent_id(0).unwrap(), saved);
    assert_eq!(merged.parent_id(1).unwrap(), remote);
    assert_eq!(
        blob(&fixture.local, saved, "notes/shared.md"),
        b"saved during fetch\n"
    );
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(
        !commit_all(&fixture.local, "no changes", LIMIT)
            .unwrap()
            .committed
    );
}

#[test]
fn fast_forward_preserves_unrelated_staged_changes() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote revision\n");
    let remote = commit(&fixture.origin);
    fetch(&fixture.local);
    write(
        &fixture.local,
        "notes/staged.md",
        "staged while network was active\n",
    );
    let repo = Repository::open(&fixture.local).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("notes/staged.md")).unwrap();
    index.write().unwrap();
    let staged_blob = index.get_path(Path::new("notes/staged.md"), 0).unwrap().id;

    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::FastForward
    ));
    assert_eq!(head(&fixture.local), remote);
    let index = Repository::open(&fixture.local).unwrap().index().unwrap();
    assert_eq!(
        index.get_path(Path::new("notes/staged.md"), 0).unwrap().id,
        staged_blob
    );
    assert_eq!(
        fs::read_to_string(fixture.local.join("notes/staged.md")).unwrap(),
        "staged while network was active\n"
    );
}

#[test]
fn pull_refuses_untracked_and_ignored_collisions() {
    for path in ["notes/untracked.md", "assets/file.ignored"] {
        let fixture = fixture();
        write(&fixture.origin, path, "remote file\n");
        let repo = Repository::open(&fixture.origin).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let signature = super::repo::signature(&repo).unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "remote file",
            &tree,
            &[&parent],
        )
        .unwrap();
        write(&fixture.local, path, "keep my file\n");
        fetch(&fixture.local);
        let original = head(&fixture.local);
        assert!(merge_remote(&fixture.local).is_err(), "{path}");
        assert_eq!(head(&fixture.local), original);
        assert_eq!(
            fs::read_to_string(fixture.local.join(path)).unwrap(),
            "keep my file\n"
        );
    }
}

#[test]
fn divergent_merge_refuses_dirty_conflicted_note_and_recovers_after_commit() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote revision\n");
    commit(&fixture.origin);
    write(
        &fixture.local,
        "notes/shared.md",
        "committed local revision\n",
    );
    let original = commit(&fixture.local);
    fetch(&fixture.local);
    write(&fixture.local, "notes/shared.md", "newer local autosave\n");

    assert!(merge_remote(&fixture.local).is_err());
    assert_eq!(head(&fixture.local), original);
    assert_eq!(
        fs::read_to_string(fixture.local.join("notes/shared.md")).unwrap(),
        "newer local autosave\n"
    );
    let repo = Repository::open(&fixture.local).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(!repo.index().unwrap().has_conflicts());
    commit(&fixture.local);
    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::MergedWithConflicts
    ));
}

#[test]
fn repeated_binary_conflicts_preserve_existing_local_and_incoming_copy_names() {
    let fixture = fixture();
    write(&fixture.origin, "assets/image.bin", b"remote first\0");
    write(
        &fixture.origin,
        "assets/image (conflict 2).bin",
        b"intentional remote file\0",
    );
    commit(&fixture.origin);
    write(&fixture.local, "assets/image.bin", b"local first\0");
    write(
        &fixture.local,
        "assets/image (conflict).bin",
        b"previous conflict\0",
    );
    commit(&fixture.local);
    fetch(&fixture.local);
    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::MergedWithConflicts
    ));
    assert_eq!(
        fs::read(fixture.local.join("assets/image (conflict 3).bin")).unwrap(),
        b"remote first\0"
    );

    write(&fixture.origin, "assets/image.bin", b"remote second\0");
    commit(&fixture.origin);
    write(&fixture.local, "assets/image.bin", b"local second\0");
    commit(&fixture.local);
    fetch(&fixture.local);
    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::MergedWithConflicts
    ));
    for (path, contents) in [
        ("assets/image.bin", b"local second\0".as_slice()),
        ("assets/image (conflict).bin", b"previous conflict\0"),
        (
            "assets/image (conflict 2).bin",
            b"intentional remote file\0",
        ),
        ("assets/image (conflict 3).bin", b"remote first\0"),
        ("assets/image (conflict 4).bin", b"remote second\0"),
    ] {
        assert_eq!(
            fs::read(fixture.local.join(path)).unwrap(),
            contents,
            "{path}"
        );
        assert_eq!(
            blob(&fixture.local, head(&fixture.local), path),
            contents,
            "{path}"
        );
    }
    assert!(
        !commit_all(&fixture.local, "no changes", LIMIT)
            .unwrap()
            .committed
    );
}

#[test]
fn failed_index_write_leaves_head_recoverable_and_retry_finishes() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote revision\n");
    let remote = commit(&fixture.origin);
    fetch(&fixture.local);
    let original = head(&fixture.local);
    fs::write(fixture.local.join(".git/index.lock"), "another writer").unwrap();
    assert!(merge_remote(&fixture.local).is_err());
    assert_eq!(head(&fixture.local), original);
    assert_eq!(blob(&fixture.local, original, "notes/shared.md"), b"base\n");
    assert_eq!(
        Repository::open(&fixture.local).unwrap().state(),
        git2::RepositoryState::Clean
    );
    fs::remove_file(fixture.local.join(".git/index.lock")).unwrap();
    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::FastForward
    ));
    assert_eq!(head(&fixture.local), remote);
    assert_eq!(
        fs::read_to_string(fixture.local.join("notes/shared.md")).unwrap(),
        "remote revision\n"
    );
}

#[test]
fn failed_checkout_keeps_a_complete_binary_conflict_copy_and_original_index() {
    let fixture = fixture();
    write(&fixture.origin, "notes/shared.md", "remote note\n");
    write(&fixture.origin, "assets/image.bin", b"remote attachment\0");
    commit(&fixture.origin);
    write(&fixture.local, "notes/shared.md", "committed local note\n");
    write(&fixture.local, "assets/image.bin", b"local attachment\0");
    let original = commit(&fixture.local);
    fetch(&fixture.local);
    let original_index = fs::read(fixture.local.join(".git/index")).unwrap();
    write(&fixture.local, "notes/shared.md", "autosave after commit\n");

    assert!(merge_remote(&fixture.local).is_err());
    assert_eq!(head(&fixture.local), original);
    assert_eq!(
        fs::read(fixture.local.join(".git/index")).unwrap(),
        original_index
    );
    assert_eq!(
        fs::read_to_string(fixture.local.join("notes/shared.md")).unwrap(),
        "autosave after commit\n"
    );
    assert_eq!(
        fs::read(fixture.local.join("assets/image.bin")).unwrap(),
        b"local attachment\0"
    );
    assert_eq!(
        fs::read(fixture.local.join("assets/image (conflict).bin")).unwrap(),
        b"remote attachment\0"
    );
    assert_eq!(
        Repository::open(&fixture.local).unwrap().state(),
        git2::RepositoryState::Clean
    );

    commit(&fixture.local);
    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::MergedWithConflicts
    ));
    assert_eq!(
        fs::read(fixture.local.join("assets/image (conflict).bin")).unwrap(),
        b"remote attachment\0"
    );
}

#[test]
fn binary_copy_avoids_incoming_case_aliases_and_directories() {
    let fixture = fixture();
    write(&fixture.origin, "assets/image.bin", b"remote attachment\0");
    write(
        &fixture.origin,
        "assets/image (CONFLICT).bin",
        b"incoming attachment\0",
    );
    write(
        &fixture.origin,
        "assets/image (CONFLICT 2).bin/keep.md",
        "incoming directory\n",
    );
    commit(&fixture.origin);
    write(&fixture.local, "assets/image.bin", b"local attachment\0");
    commit(&fixture.local);
    fetch(&fixture.local);

    assert!(matches!(
        merge_remote(&fixture.local).unwrap().kind,
        MergeKind::MergedWithConflicts
    ));
    for (path, contents) in [
        ("assets/image.bin", b"local attachment\0".as_slice()),
        ("assets/image (CONFLICT).bin", b"incoming attachment\0"),
        (
            "assets/image (CONFLICT 2).bin/keep.md",
            b"incoming directory\n",
        ),
        ("assets/image (conflict 3).bin", b"remote attachment\0"),
    ] {
        assert_eq!(
            fs::read(fixture.local.join(path)).unwrap(),
            contents,
            "{path}"
        );
        assert_eq!(
            blob(&fixture.local, head(&fixture.local), path),
            contents,
            "{path}"
        );
    }
}
