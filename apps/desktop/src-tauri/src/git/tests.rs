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
    setup(&graph_a, Some(remote_url.clone()), None).unwrap();

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
    let first = commit_all(root, "first", MAX_FILE_BYTES).unwrap();
    assert!(first.ahead >= 1, "{first:?}");

    let outcome = push(root, None).unwrap();
    assert!(outcome.pushed, "push failed: {outcome:?}");

    let delta = fetch(root, None).unwrap();
    assert_eq!(delta.ahead, 0);
    assert_eq!(delta.behind, 0);

    // The engine's skip condition: a clean no-op commit that is also not
    // ahead means there is nothing to push at all.
    let idle = commit_all(root, "noop", MAX_FILE_BYTES).unwrap();
    assert!(!idle.committed);
    assert_eq!(idle.ahead, 0);
}

#[test]
fn disconnect_drops_origin_but_keeps_history() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES).unwrap();
    push(root, None).unwrap();

    let after = super::disconnect(root).unwrap();
    assert!(after.initialized);
    assert!(after.remote_url.is_none());
    assert!(head_tree_paths(root).contains(&"notes/a.md".to_string()));

    // Idempotent, and reconnecting works.
    super::disconnect(root).unwrap();
    let reconnected = setup(root, Some(fixture.remote_url.clone()), None).unwrap();
    assert!(reconnected.remote_url.is_some());
}

#[test]
fn clone_restores_a_backup_into_an_empty_destination() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES).unwrap();
    push(root, None).unwrap();

    let target = fixture._dir.path().join("restored");
    super::remote::clone(&fixture.remote_url, &target, None).unwrap();
    assert_eq!(read(&target, "notes/a.md"), "# A\n");

    // A non-empty destination is refused — a restore must never overwrite.
    let occupied = fixture._dir.path().join("occupied");
    fs::create_dir_all(&occupied).unwrap();
    fs::write(occupied.join("keep.txt"), "existing").unwrap();
    assert!(super::remote::clone(&fixture.remote_url, &occupied, None).is_err());
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
fn connecting_an_existing_backup_on_another_branch_pulls_its_history() {
    let dir = tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("master");
    Repository::init_opts(&bare, &opts).unwrap();
    let remote_url = bare.to_string_lossy().into_owned();

    // Seed the remote with existing history on `master` (the user's old repo).
    let seed = dir.path().join("seed");
    fs::create_dir_all(&seed).unwrap();
    let mut seed_opts = RepositoryInitOptions::new();
    seed_opts.initial_head("master");
    Repository::init_opts(&seed, &seed_opts).unwrap();
    setup(&seed, Some(remote_url.clone()), None).unwrap();
    write(&seed, "notes/existing.md", "# Existing\n");
    commit_all(&seed, "seed", MAX_FILE_BYTES).unwrap();
    push(&seed, None).unwrap();

    // A fresh graph (local default would be `main`) connects to it; the
    // GitHub API reports `master` as the default branch and setup aligns the
    // local branch — without this, merge looks for origin/main, sees nothing,
    // and push creates a parallel branch instead of integrating the backup
    // (PR #96 review).
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    setup(&root, Some(remote_url), Some("master".to_string())).unwrap();
    assert_eq!(status(&root).unwrap().branch.as_deref(), Some("master"));

    // The engine's launch cycle: the local root commit and the remote history
    // are unrelated, and the merge must still integrate them.
    commit_all(&root, "local notes", MAX_FILE_BYTES).unwrap();
    fetch(&root, None).unwrap();
    let merged = merge_remote(&root).unwrap();
    assert!(
        matches!(
            merged.kind,
            MergeKind::Merged | MergeKind::MergedWithConflicts
        ),
        "{merged:?}"
    );
    assert!(push(&root, None).unwrap().pushed);

    let paths = head_tree_paths(&root);
    assert!(
        paths.contains(&"notes/existing.md".to_string()),
        "{paths:?}"
    );
    assert!(paths.contains(&".gitignore".to_string()));
}

#[test]
fn aligning_onto_a_stale_local_branch_keeps_the_working_tree() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    // History: commit 1, a stale local `master` pointing at it, then commit 2
    // on `main` with newer content.
    write(root, "notes/ours.md", "# Ours v1\n");
    commit_all(root, "v1", MAX_FILE_BYTES).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("master", &head, false).unwrap();
    }
    write(root, "notes/ours.md", "# Ours v2\n");
    commit_all(root, "v2", MAX_FILE_BYTES).unwrap();

    // Aligning onto the stale name must keep our content (HEAD's commit and
    // the working tree are untouched — the stale branch loses the name, we
    // don't lose notes to its old tree).
    setup(root, None, Some("master".to_string())).unwrap();
    assert_eq!(status(root).unwrap().branch.as_deref(), Some("master"));
    assert_eq!(read(root, "notes/ours.md"), "# Ours v2\n");
    assert!(head_tree_paths(root).contains(&"notes/ours.md".to_string()));

    // And the repo is immediately usable: a no-op commit stays a no-op (the
    // tree still matches HEAD — nothing was silently reverted).
    let outcome = commit_all(root, "noop", MAX_FILE_BYTES).unwrap();
    assert!(!outcome.committed, "align must not desync tree and HEAD");
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
    // The merge reports what it wrote (b's note) so the caller can reindex
    // without depending on the file watcher — with the file's real mtime.
    assert_eq!(
        merged
            .changed_files
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        vec!["notes/b.md"],
    );
    assert!(
        merged.changed_files[0].modified_ms.is_some(),
        "upserts carry the written file's mtime: {merged:?}"
    );
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
    assert!(
        merged
            .changed_files
            .iter()
            .any(|change| change.path == "notes/shared.md"),
        "{merged:?}"
    );

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
fn detached_head_is_a_typed_error_not_a_panic() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "base", MAX_FILE_BYTES).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let oid = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(oid).unwrap();
    }

    let err = merge_remote(root).unwrap_err();
    let crate::error::AppError::Io { message } = err else {
        panic!("expected an Io error, got {err:?}");
    };
    assert!(message.contains("detached HEAD"), "{message}");
    assert!(matches!(
        push(root, None).unwrap_err(),
        crate::error::AppError::Io { .. }
    ));
}

#[test]
fn merging_into_an_unborn_repo_adopts_the_remote_history() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "seed", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    // A fresh graph with no commits yet (unborn HEAD) connects to an existing
    // backup; the merge must adopt the remote history, not error on the
    // missing local branch.
    let root = fixture._dir.path().join("fresh");
    scaffold_graph(&root);
    setup(&root, Some(fixture.remote_url.clone()), None).unwrap();
    fetch(&root, None).unwrap();

    let merged = merge_remote(&root).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(&root, "notes/a.md"), "# A\n");
    let upsert = merged
        .changed_files
        .iter()
        .find(|change| change.path == "notes/a.md")
        .expect("the adopted file is reported for reindexing");
    assert!(upsert.modified_ms.is_some(), "{merged:?}");
    assert!(head_tree_paths(&root).contains(&"notes/a.md".to_string()));
}

#[test]
fn rename_rename_conflict_keeps_both_names_and_confirms_the_removal() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(
        root_a,
        "notes/orig.md",
        "# Original\n\nshared content that travels with the rename\n",
    );
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    fs::rename(
        root_b.join("notes/orig.md"),
        root_b.join("notes/renamed-b.md"),
    )
    .unwrap();
    commit_all(&root_b, "b rename", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::rename(
        root_a.join("notes/orig.md"),
        root_a.join("notes/renamed-a.md"),
    )
    .unwrap();
    commit_all(root_a, "a rename", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();

    // Rename detection turns this into three conflict groups: ours-only
    // (renamed-a), theirs-only (renamed-b), and ancestor-only (orig — gone on
    // both sides). The last one must be cleared from the index or the merge
    // tree could not be written at all.
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    let paths = head_tree_paths(root_a);
    assert!(
        paths.contains(&"notes/renamed-a.md".to_string()),
        "{paths:?}"
    );
    assert!(
        paths.contains(&"notes/renamed-b.md".to_string()),
        "{paths:?}"
    );
    assert!(!paths.contains(&"notes/orig.md".to_string()), "{paths:?}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
}

#[cfg(unix)]
#[test]
fn failed_merge_completion_still_clears_the_merge_state() {
    use std::os::unix::fs::PermissionsExt;

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

    // Make restoring the surviving edit fail mid-completion: the notes
    // directory refuses new files, so write_blob cannot recreate keep.md.
    let notes_dir = root_a.join("notes");
    fs::set_permissions(&notes_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let result = merge_remote(root_a);
    fs::set_permissions(&notes_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(result.is_err(), "{result:?}");

    // The contract: a failed merge never wedges the repo mid-merge…
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    drop(repo);

    // …and the next cycle recovers on its own.
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(read(root_a, "notes/keep.md"), "# Keep\n\nedited on b\n");
}

#[test]
fn fetch_without_remote_is_a_typed_error() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    setup(&root, None, None).unwrap();
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

    setup(&root, None, None).unwrap();
    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("node_modules/"));
    assert!(gitignore.contains("/.reflect/"));

    // Idempotent: a second setup must not duplicate the entry.
    setup(&root, None, None).unwrap();
    let again = read(&root, ".gitignore");
    assert_eq!(again.matches(".reflect").count(), 1, "{again}");
}
