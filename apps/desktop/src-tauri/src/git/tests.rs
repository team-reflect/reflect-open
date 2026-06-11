//! Integration tests for the git primitives, exercised against tempdir graphs
//! and a local bare "remote" (libgit2's local transport — no network, no
//! credentials, same code paths as HTTPS apart from auth).

use std::fs;
use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions};
use tempfile::{tempdir, TempDir};

use super::commit::commit_all;
use super::merge::{merge_remote, MergeKind};
use super::remote::{fetch, push};
use super::{setup, status, MAX_FILE_BYTES};

/// Scaffold a minimal graph layout (what `fs::bootstrap` produces).
fn scaffold_graph(root: &Path) {
    for dir in ["daily", "notes", "assets", ".reflect"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    fs::write(
        root.join(".gitignore"),
        "# Reflect local index + caches (rebuildable; never committed)\n/.reflect/\n",
    )
    .unwrap();
    fs::write(root.join(".reflect/index.sqlite"), "not a real db").unwrap();
}

fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

/// A bare remote + a primary graph connected to it.
struct Fixture {
    _dir: TempDir,
    remote_url: String,
    graph_a: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("main");
    Repository::init_opts(&bare, &opts).unwrap();
    let remote_url = bare.to_string_lossy().into_owned();

    let graph_a = dir.path().join("graph-a");
    scaffold_graph(&graph_a);
    setup(&graph_a, Some(remote_url.clone())).unwrap();

    Fixture {
        _dir: dir,
        remote_url,
        graph_a,
    }
}

/// Clone the remote into a second "device". `commit_all`/`merge_remote` only
/// need a repo at the root, so the clone stands in for a second graph.
fn second_device(fixture: &Fixture) -> PathBuf {
    let root = fixture._dir.path().join("graph-b");
    Repository::clone(&fixture.remote_url, &root).unwrap();
    root
}

fn head_tree_paths(root: &Path) -> Vec<String> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let mut paths = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            paths.push(format!("{prefix}{}", entry.name().unwrap_or("")));
        }
        git2::TreeWalkResult::Ok
    })
    .unwrap();
    paths
}

#[test]
fn setup_initializes_main_and_origin() {
    let fixture = fixture();
    let status = status(&fixture.graph_a).unwrap();
    assert!(status.initialized);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(
        status.remote_url.as_deref(),
        Some(fixture.remote_url.as_str())
    );
    assert!(!status.in_progress);
}

#[test]
fn commit_excludes_reflect_and_skips_when_clean() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");

    let first = commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert!(first.committed);
    assert!(first.sha.is_some());

    let paths = head_tree_paths(root);
    assert!(paths.contains(&"notes/a.md".to_string()));
    assert!(paths.contains(&".gitignore".to_string()));
    assert!(
        !paths.iter().any(|path| path.starts_with(".reflect")),
        ".reflect/ leaked into backup: {paths:?}"
    );

    let second = commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert!(!second.committed, "clean tree must not produce a commit");
}

#[test]
fn commit_records_deletions() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/gone.md", "# Gone\n");
    commit_all(root, "add", MAX_FILE_BYTES).unwrap();

    fs::remove_file(root.join("notes/gone.md")).unwrap();
    let outcome = commit_all(root, "delete", MAX_FILE_BYTES).unwrap();
    assert!(outcome.committed);
    assert!(!head_tree_paths(root).contains(&"notes/gone.md".to_string()));
}

#[test]
fn oversized_files_are_skipped_and_reported() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    // Commit the scaffold first: tracked-but-unchanged files (like the
    // .gitignore, larger than the tiny test threshold) must NOT be reported —
    // only files whose changes are actually being withheld.
    commit_all(root, "scaffold", MAX_FILE_BYTES).unwrap();

    write(root, "notes/small.md", "tiny\n");
    write(root, "assets/huge.bin", "0123456789abcdef");

    let outcome = commit_all(root, "guarded", 10).unwrap();
    assert!(outcome.committed);
    assert_eq!(
        outcome.skipped_large_files.len(),
        1,
        "{:?}",
        outcome.skipped_large_files
    );
    assert_eq!(outcome.skipped_large_files[0].path, "assets/huge.bin");

    let paths = head_tree_paths(root);
    assert!(paths.contains(&"notes/small.md".to_string()));
    assert!(!paths.contains(&"assets/huge.bin".to_string()));
}

#[test]
fn push_and_fetch_round_trip() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES).unwrap();

    let outcome = push(root, None).unwrap();
    assert!(outcome.pushed, "push failed: {outcome:?}");

    let delta = fetch(root, None).unwrap();
    assert_eq!(delta.ahead, 0);
    assert_eq!(delta.behind, 0);
}

#[test]
fn first_sync_against_an_empty_remote_pushes() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES).unwrap();

    // The engine's launch cycle is commit → fetch → merge → push. A brand-new
    // backup repo has no remote branch yet; that must not error the cycle
    // before the push that creates it (PR #96 review).
    let delta = fetch(root, None).unwrap();
    assert_eq!(delta.behind, 0);
    assert!(delta.ahead >= 1, "local commits count as ahead: {delta:?}");
    let merged = merge_remote(root).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    assert!(push(root, None).unwrap().pushed);
}

#[test]
fn non_fast_forward_push_is_rejected_as_data() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    commit_all(&root_b, "from b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/c.md", "# C\n");
    commit_all(root_a, "from a", MAX_FILE_BYTES).unwrap();
    let rejected = push(root_a, None).unwrap();
    assert!(!rejected.pushed);
    assert!(
        rejected.non_fast_forward,
        "expected non-fast-forward, got: {rejected:?}"
    );

    // The standard recovery: fetch, merge (clean — different files), push.
    let delta = fetch(root_a, None).unwrap();
    assert_eq!(delta.behind, 1);
    assert_eq!(delta.ahead, 1);
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(push(root_a, None).unwrap().pushed);
}

#[test]
fn conflicting_edits_are_committed_with_labeled_markers() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/shared.md", "# Shared\n\noriginal line\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/shared.md", "# Shared\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/shared.md", "# Shared\n\nedited on a\n");
    commit_all(root_a, "a edit", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(merged.conflicted_paths, vec!["notes/shared.md".to_string()]);

    let content = read(root_a, "notes/shared.md");
    assert!(content.contains("<<<<<<< this device"), "{content}");
    assert!(content.contains("edited on a"), "{content}");
    assert!(content.contains("edited on b"), "{content}");
    assert!(content.contains(">>>>>>> other device"), "{content}");

    // The conflict is committed: the repo is never wedged mid-merge, and the
    // push goes through so both devices converge on the same marked-up note.
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(push(root_a, None).unwrap().pushed);

    fetch(&root_b, None).unwrap();
    let converged = merge_remote(&root_b).unwrap();
    assert!(
        matches!(converged.kind, MergeKind::FastForward),
        "{converged:?}"
    );
    assert_eq!(read(&root_b, "notes/shared.md"), content);
}

#[test]
fn edit_vs_delete_keeps_the_edit() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/keep.md", "# Keep\n\noriginal\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/keep.md", "# Keep\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::remove_file(root_a.join("notes/keep.md")).unwrap();
    commit_all(root_a, "a delete", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    let content = read(root_a, "notes/keep.md");
    assert!(content.contains("edited on b"), "{content}");
    assert!(head_tree_paths(root_a).contains(&"notes/keep.md".to_string()));
}

#[test]
fn binary_conflict_keeps_both_copies() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    fs::write(root_a.join("assets/img.bin"), b"\x00base\x01").unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    fs::write(root_b.join("assets/img.bin"), b"\x00from-b\x01").unwrap();
    commit_all(&root_b, "b image", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::write(root_a.join("assets/img.bin"), b"\x00from-a\x01").unwrap();
    commit_all(root_a, "a image", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    assert_eq!(
        fs::read(root_a.join("assets/img.bin")).unwrap(),
        b"\x00from-a\x01"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict).bin")).unwrap(),
        b"\x00from-b\x01"
    );
    let paths = head_tree_paths(root_a);
    assert!(paths.contains(&"assets/img.bin".to_string()));
    assert!(paths.contains(&"assets/img (conflict).bin".to_string()));
}

#[test]
fn fetch_without_remote_is_a_typed_error() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    setup(&root, None).unwrap();
    let err = fetch(&root, None).unwrap_err();
    assert!(matches!(err, crate::error::AppError::NotFound { .. }));
}

#[test]
fn adopting_an_existing_repo_appends_reflect_ignore() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
    Repository::init(&root).unwrap();

    setup(&root, None).unwrap();
    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("node_modules/"));
    assert!(gitignore.contains("/.reflect/"));

    // Idempotent: a second setup must not duplicate the entry.
    setup(&root, None).unwrap();
    let again = read(&root, ".gitignore");
    assert_eq!(again.matches(".reflect").count(), 1, "{again}");
}
