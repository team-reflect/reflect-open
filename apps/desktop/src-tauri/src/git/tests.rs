use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use git2::{Repository, RepositoryInitOptions};
use tempfile::tempdir;

use super::commit::commit_all;
use super::fault::{self, Fault, FaultPoint};
use super::merge::{merge_remote, MergeKind};
use super::remote::{fetch, push, remote_head};
use super::test_support::{
    copy_note, fixture, head_blob, head_message, head_tree_paths, read, remote_blob,
    scaffold_graph, second_device, write, Fixture,
};
use super::{setup, status, MAX_FILE_BYTES};

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
fn setup_creates_graph_gitignore_defaults_when_missing() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    fs::create_dir_all(&root).unwrap();

    setup(&root, None, None).unwrap();

    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("/.reflect/"));
    assert!(gitignore.contains(".DS_Store"));
    assert!(gitignore.contains("Thumbs.db"));
    assert!(gitignore.contains("*.swp"));
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
fn commit_describes_single_note_changes() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/project-atlas.md", "# Project Atlas\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add Project Atlas");

    write(
        root,
        "notes/project-atlas.md",
        "# Project Atlas\n\nNext step\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Update Project Atlas");

    fs::remove_file(root.join("notes/project-atlas.md")).unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Delete Project Atlas");
}

#[test]
fn commit_uses_authored_note_subjects() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "---\ntitle: \"Project #1\"\n---\n# Ignored H1\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add Project #1");

    write(
        root,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "# Launch Review\n\n- agenda\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Update Launch Review");

    fs::remove_file(root.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Delete Launch Review");
}

#[test]
fn commit_describes_note_renames() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/original.md",
        "# Original Name\n\n- stable body line one\n- stable body line two\n- stable body line three\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();

    fs::remove_file(root.join("notes/original.md")).unwrap();
    write(
        root,
        "notes/renamed.md",
        "# Renamed Name\n\n- stable body line one\n- stable body line two\n- stable body line three\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Rename Original Name to Renamed Name");
}

#[test]
fn commit_does_not_leak_private_authored_titles() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/private-project.md",
        "---\nprivate: true\ntitle: Secret Plan\n---\n# Secret Heading\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add private note");
}

#[test]
fn commit_summarizes_note_batches() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "daily/2026-06-23.md", "# Daily\n");
    write(root, "notes/project-atlas.md", "# Project Atlas\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add 2 notes");

    write(root, "daily/2026-06-23.md", "# Daily\n\n- one\n");
    write(
        root,
        "notes/project-atlas.md",
        "# Project Atlas\n\nNext step\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Update 2 notes");
}

#[test]
fn commit_mentions_note_and_attachment_batches() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/capture.md", "# Capture\n");
    write(root, "assets/screenshot.png", "not really a png\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add 1 note and 1 attachment");
}

#[test]
fn commit_describes_mixed_note_and_file_batches_by_action() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/capture.md", "# Capture\n");
    write(root, "books/book.json", "{}\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Add 1 note and 1 file");
}

#[test]
fn commit_falls_back_for_metadata_only_changes() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    commit_all(root, "Update notes", MAX_FILE_BYTES).unwrap();
    assert_eq!(head_message(root), "Update notes");
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
fn tracked_reflect_entries_are_dropped_from_the_next_commit() {
    // A repository adopted from another tool already tracked the runtime
    // directory; the next commit must record its removal.
    let fixture = fixture();
    let root = &fixture.graph_a;
    {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(".reflect/index.sqlite")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo
            .signature()
            .unwrap_or_else(|_| git2::Signature::now("t", "t@t").unwrap());
        repo.commit(Some("HEAD"), &sig, &sig, "tracked .reflect", &tree, &[])
            .unwrap();
    }
    assert!(head_tree_paths(root).contains(&".reflect/index.sqlite".to_string()));

    write(root, "notes/a.md", "# A\n");
    let outcome = commit_all(root, "next", MAX_FILE_BYTES).unwrap();
    assert!(outcome.committed);
    let paths = head_tree_paths(root);
    assert!(
        !paths.iter().any(|path| path.starts_with(".reflect/")),
        "{paths:?}"
    );
    assert!(
        root.join(".reflect/index.sqlite").exists(),
        "only untracked, never deleted"
    );
}

#[test]
fn prestaged_oversized_file_is_withheld() {
    // Staged before it grew: the add-time guard never sees it again.
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "assets/big.bin", "small");
    commit_all(root, "small", MAX_FILE_BYTES).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        fs::write(root.join("assets/big.bin"), vec![0u8; 64]).unwrap();
        index.add_path(Path::new("assets/big.bin")).unwrap();
        index.write().unwrap();
    }
    let outcome = commit_all(root, "guarded", 32).unwrap();
    assert_eq!(outcome.skipped_large_files.len(), 1);
    assert_eq!(outcome.skipped_large_files[0].path, "assets/big.bin");
    // The tracked path keeps its committed blob: nothing new to commit, and
    // no deletion for other devices to pull.
    assert!(!outcome.committed);
    assert_eq!(head_blob(root, "assets/big.bin"), "small");
}

#[test]
fn prestaged_oversized_new_file_stays_out_of_the_commit() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    commit_all(root, "scaffold", MAX_FILE_BYTES).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        write(root, "assets/new.bin", "0123456789abcdef");
        index.add_path(Path::new("assets/new.bin")).unwrap();
        index.write().unwrap();
    }
    let outcome = commit_all(root, "guarded", 10).unwrap();
    assert_eq!(outcome.skipped_large_files[0].path, "assets/new.bin");
    assert!(!head_tree_paths(root).contains(&"assets/new.bin".to_string()));
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
        matches!(merged.kind, MergeKind::Merged | MergeKind::MergedWithReview),
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
fn conflicting_edits_merge_without_markers() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/shared.md", "# Shared\n\noriginal line\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/shared.md", "# Shared\n\nedited on bravo\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/shared.md", "# Shared\n\nedited on alpha\n");
    commit_all(root_a, "a edit", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(merged.review_paths.is_empty(), "{merged:?}");
    assert!(
        merged
            .changed_files
            .iter()
            .any(|change| change.path == "notes/shared.md"),
        "{merged:?}"
    );

    let content = read(root_a, "notes/shared.md");
    assert_merged_without_markers(&content, &["alpha", "bravo"]);
    assert_eq!(head_blob(root_a, "notes/shared.md"), content);

    // The merge is committed: the repo is never wedged mid-merge, and the
    // push goes through so both devices converge on the same note.
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

/// `content` carries no conflict markers and holds every word in `words`.
fn assert_merged_without_markers(content: &str, words: &[&str]) {
    for marker in ["<<<<<<<", "=======", ">>>>>>>"] {
        assert!(!content.contains(marker), "{content}");
    }
    for word in words {
        assert!(content.contains(word), "{word} is missing: {content}");
    }
}

/// The archived versions of `rel` on the device at `root`.
fn archived(root: &Path, rel: &str) -> Vec<crate::conflict::archive::ArchivedVersion> {
    crate::conflict::archive::list(root, rel).unwrap()
}

#[test]
fn daily_append_on_two_devices_merges_by_union() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let rel = "daily/2026-10-01.md";
    write(root_a, rel, "# 2026-10-01\n\n- morning\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, rel, "# 2026-10-01\n\n- morning\n- lunch on b\n");
    commit_all(&root_b, "b append", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, rel, "# 2026-10-01\n\n- morning\n- coffee on a\n");
    commit_all(root_a, "a append", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(merged.review_paths.is_empty(), "{merged:?}");

    let content = read(root_a, rel);
    assert!(
        content.starts_with("# 2026-10-01\n\n- morning\n"),
        "{content}"
    );
    assert_merged_without_markers(&content, &["- lunch on b\n", "- coffee on a\n"]);
    assert!(archived(root_a, rel).is_empty());

    assert!(push(root_a, None).unwrap().pushed);
    fetch(&root_b, None).unwrap();
    merge_remote(&root_b).unwrap();
    assert_eq!(read(&root_b, rel), content);
}

#[test]
fn frontmatter_only_conflict_merges_keywise() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let rel = "notes/tagged.md";
    write(root_a, rel, "---\ntitle: Tagged\n---\n# Tagged\n\nbody\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(
        &root_b,
        rel,
        "---\ntitle: Tagged\nstatus: draft\n---\n# Tagged\n\nbody\n",
    );
    commit_all(&root_b, "b header", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(
        root_a,
        rel,
        "---\ntitle: Tagged\nowner: alex\n---\n# Tagged\n\nbody\n",
    );
    commit_all(root_a, "a header", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");

    let content = read(root_a, rel);
    assert_merged_without_markers(
        &content,
        &["title: Tagged\n", "status: draft\n", "owner: alex\n"],
    );
    assert!(content.ends_with("---\n# Tagged\n\nbody\n"), "{content}");
    assert_eq!(content.matches("---\n").count(), 2, "{content}");
}

#[test]
fn both_devices_resolve_the_same_pair_to_the_same_bytes() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let rel = "notes/shared.md";
    write(root_a, rel, "# Shared\n\noriginal line\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, rel, "# Shared\n\nrewritten on bravo\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, rel, "# Shared\n\nchanged on alpha\n");
    commit_all(root_a, "a edit", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();

    // B fetches A's unpushed commit as its tracking branch, so each device
    // merges the mirror of the other's pair.
    {
        let repo_b = Repository::open(&root_b).unwrap();
        let mut remote = repo_b.remote_anonymous(&root_a.to_string_lossy()).unwrap();
        remote
            .fetch(&["+refs/heads/main:refs/remotes/origin/main"], None, None)
            .unwrap();
    }

    let merged_a = merge_remote(root_a).unwrap();
    let merged_b = merge_remote(&root_b).unwrap();
    assert!(matches!(merged_a.kind, MergeKind::Merged), "{merged_a:?}");
    assert!(matches!(merged_b.kind, MergeKind::Merged), "{merged_b:?}");

    let content = head_blob(root_a, rel);
    assert_eq!(head_blob(&root_b, rel), content);
    assert_eq!(read(&root_b, rel), content);
    assert_merged_without_markers(&content, &["alpha", "bravo"]);
    // Both sides are reachable from the merge's parents, so nothing is archived.
    assert!(archived(root_a, rel).is_empty());
    assert!(archived(&root_b, rel).is_empty());
}

#[test]
fn a_deletion_beside_an_append_is_reconciled_not_resurrected() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let rel = "notes/list.md";
    let base = "a\nb\nc\n";
    let deleted = "a\nb\n";
    let appended = "a\nb\nc\nd\n";
    write(root_a, rel, base);
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, rel, appended);
    commit_all(&root_b, "b append", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, rel, deleted);
    commit_all(root_a, "a delete", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(merged.review_paths.is_empty(), "{merged:?}");

    let side = |content: &str, modified_ms| crate::conflict::ConflictSide {
        content: content.to_string(),
        label: String::new(),
        modified_ms,
    };
    let expected = crate::conflict::ladder::resolve(crate::conflict::ladder::ConflictInput {
        base: Some(base),
        sides: (side(deleted, 1), side(appended, 2)),
        merge_loop_detected: false,
    })
    .unwrap();
    let crate::conflict::Resolution::Reconciled { content: expected } = expected else {
        panic!("the ladder must reconcile this pair, not merge it exactly: {expected:?}");
    };
    let content = read(root_a, rel);
    assert_eq!(content, expected);
    assert_eq!(content, "a\nb\nd\n", "the deletion must stay deleted");
    // Both sides are in history, so the reconcile archives neither.
    assert!(archived(root_a, rel).is_empty());
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
        matches!(merged.kind, MergeKind::MergedWithReview),
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
        matches!(merged.kind, MergeKind::MergedWithReview),
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
    let crate::error::AppError::Io { message, .. } = err else {
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
        matches!(merged.kind, MergeKind::MergedWithReview),
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
fn adopting_an_existing_repo_appends_graph_gitignore_defaults() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
    Repository::init(&root).unwrap();

    setup(&root, None, None).unwrap();
    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("node_modules/"));
    assert!(gitignore.contains("/.reflect/"));
    assert!(gitignore.contains(".DS_Store"));
    assert!(gitignore.contains("Thumbs.db"));
    assert!(gitignore.contains("*.swp"));

    // Idempotent: a second setup must not duplicate the entry.
    setup(&root, None, None).unwrap();
    let again = read(&root, ".gitignore");
    assert_eq!(again.matches(".reflect").count(), 1, "{again}");
    assert_eq!(again.matches(".DS_Store").count(), 1, "{again}");
    assert_eq!(again.matches("Thumbs.db").count(), 1, "{again}");
    assert_eq!(again.matches("*.swp").count(), 1, "{again}");
}

// ---- the Plan 17 rename matrix ----------------------------------------------
// Title renames now move files (delete+add in git terms). These pin the three
// new merge shapes: rename+edit must converge via rename detection, and the
// two genuinely new conflict shapes (add/add, rename/rename) must surface
// without wedging or losing content.

#[test]
fn rename_on_one_device_merges_with_edit_on_the_other() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let base = "# Meeting Notes\n\n- agenda point one\n- agenda point two\n- agenda point three\n";
    write(root_a, "notes/01arz3ndektsv4rrffq69g5fav.md", base);
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    // Device B edits a body line of the old path.
    let root_b = second_device(&fixture);
    write(
        &root_b,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "# Meeting Notes\n\n- agenda point one\n- agenda point two EDITED ON B\n- agenda point three\n",
    );
    commit_all(&root_b, "b edit", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    // Device A renames the file the way the rename pipeline does: the slug
    // path changes and the H1 line with it; the body is untouched.
    fs::remove_file(root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        root_a,
        "notes/meeting-notes.md",
        "# Meeting Notes\n\n- agenda point one\n- agenda point two\n- agenda point three\n",
    );
    commit_all(root_a, "rename", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();

    // Rename detection (libgit2 merge default) lands B's edit in the moved
    // file — no conflict, no resurrected ULID path.
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(merged.review_paths.is_empty(), "{merged:?}");
    let content = read(root_a, "notes/meeting-notes.md");
    assert!(content.contains("EDITED ON B"), "{content}");
    assert!(!root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md").exists());
    assert!(push(root_a, None).unwrap().pushed);
}

#[test]
fn same_title_created_on_two_devices_merges_both_notes() {
    // New with slug filenames: two offline devices can create the same path.
    // The merge must keep both notes' text in one file, not wedge.
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/seed.md", "# Seed\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(
        &root_b,
        "notes/meeting.md",
        "# Meeting\n\nnotes from device b\n",
    );
    commit_all(&root_b, "b creates", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(
        root_a,
        "notes/meeting.md",
        "# Meeting\n\nnotes from device a\n",
    );
    commit_all(root_a, "a creates", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();

    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(merged.review_paths.is_empty(), "{merged:?}");
    let content = read(root_a, "notes/meeting.md");
    assert_merged_without_markers(&content, &["# Meeting", "device a", "device b"]);
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(push(root_a, None).unwrap().pushed);
}

#[test]
fn diverging_renames_keep_both_files_and_never_wedge() {
    // Both devices retitle the same note differently while offline: the note
    // forks into two paths. Accepted outcome (the duplicate-id flag surfaces
    // the fork at index time): both files survive, nothing wedges.
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let base = "# Shared\n\n- line one\n- line two\n- line three\n";
    write(root_a, "notes/01arz3ndektsv4rrffq69g5fav.md", base);
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    fs::remove_file(root_b.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        &root_b,
        "notes/title-b.md",
        "# Title B\n\n- line one\n- line two\n- line three\n",
    );
    commit_all(&root_b, "b rename", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::remove_file(root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        root_a,
        "notes/title-a.md",
        "# Title A\n\n- line one\n- line two\n- line three\n",
    );
    commit_all(root_a, "a rename", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();

    // Whatever the merge classifies this as, the invariants hold: no wedge,
    // both titles' content present, the old path gone, and the result pushes.
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean, "{merged:?}");
    assert!(root_a.join("notes/title-a.md").exists(), "{merged:?}");
    assert!(root_a.join("notes/title-b.md").exists(), "{merged:?}");
    assert!(!root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md").exists());
    assert!(read(root_a, "notes/title-a.md").contains("Title A"));
    assert!(read(root_a, "notes/title-b.md").contains("Title B"));
    assert!(push(root_a, None).unwrap().pushed);
}

// ---- Sync safety regressions (Phase 0 of the sync rework) -------------------
//
// These pin the data-loss paths in `docs/git-backup-safety.md`.

/// The phone pushed a new note and linked it from the daily note; the Mac
/// still has the old tree checked out and has fetched the phone's commit.
fn pulled_note_fixture() -> Fixture {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "daily/2026-10-01.md", "# 2026-10-01\n\n- morning\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/from-phone.md", PHONE_NOTE);
    write(&root_b, "daily/2026-10-01.md", PHONE_DAILY);
    commit_all(&root_b, "phone", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fetch(root_a, None).unwrap();
    fixture
}

/// Bound on every cross-thread wait so a regression hangs loudly, not forever.
const WAIT: Duration = Duration::from_secs(10);

const PHONE_NOTE: &str = "# From phone\n";
const PHONE_DAILY: &str = "# 2026-10-01\n\n- morning\n- [[From phone]]\n";

/// The next cycle after a failed pull (commit, fetch, merge, push) must keep
/// the phone's note and its daily-note link on disk, in `HEAD`, and on the
/// remote, byte for byte. The failure mode this guards against is a commit
/// of the stale working tree: the pulled note deleted, the daily note
/// reverted, and both pushed (#1405).
fn assert_next_cycle_keeps_pulled_notes(fixture: &Fixture) {
    let root_a = &fixture.graph_a;
    commit_all(root_a, "Update notes", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    merge_remote(root_a).unwrap();
    assert!(push(root_a, None).unwrap().pushed);

    assert!(
        root_a.join("notes/from-phone.md").exists(),
        "the pulled note was deleted from the working tree ({})",
        head_message(root_a)
    );
    for (rel, expected) in [
        ("notes/from-phone.md", PHONE_NOTE),
        ("daily/2026-10-01.md", PHONE_DAILY),
    ] {
        assert_eq!(read(root_a, rel), expected, "{rel} on disk");
        assert_eq!(head_blob(root_a, rel), expected, "{rel} in HEAD");
        assert_eq!(remote_blob(fixture, rel), expected, "{rel} on the remote");
    }
}

#[test]
fn fast_forward_with_a_stale_head_lock_succeeds() {
    // No `set_head` on the fast-forward path: a leftover lock file from a
    // killed process must not fail every pull.
    let fixture = pulled_note_fixture();
    fs::write(fixture.graph_a.join(".git/HEAD.lock"), b"").unwrap();
    let merged = merge_remote(&fixture.graph_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(&fixture.graph_a, "notes/from-phone.md"), PHONE_NOTE);
}

#[test]
fn fast_forward_failure_before_the_ref_moves_converges_next_cycle() {
    // A failure before anything happened must be a plain retry.
    let fixture = pulled_note_fixture();
    fault::arm(FaultPoint::BeforeFastForwardRefMove, Fault::Fail);
    assert!(merge_remote(&fixture.graph_a).is_err());
    assert_next_cycle_keeps_pulled_notes(&fixture);
}

#[test]
fn fast_forward_checkout_failure_never_reverts_pulled_notes() {
    let fixture = pulled_note_fixture();
    fault::arm(FaultPoint::BeforeFastForwardCheckout, Fault::Fail);
    assert!(merge_remote(&fixture.graph_a).is_err());
    assert_next_cycle_keeps_pulled_notes(&fixture);
}

#[test]
fn stale_head_lock_fast_forward_never_reverts_pulled_notes() {
    // The field case behind #1405: a lock file left by a killed process. It
    // stays in place for the whole test, as it did for the user, because
    // nothing in the app removes it.
    let fixture = pulled_note_fixture();
    fs::write(fixture.graph_a.join(".git/HEAD.lock"), b"").unwrap();
    let _ = merge_remote(&fixture.graph_a);
    assert_next_cycle_keeps_pulled_notes(&fixture);
}

#[test]
fn commit_during_fast_forward_never_reverts_pulled_notes() {
    // The quit-time flush commits outside the engine's queue, so it can land
    // while a pull is between the ref move and the checkout.
    let fixture = pulled_note_fixture();
    let root_a = fixture.graph_a.clone();
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let pull = thread::spawn({
        let root = root_a.clone();
        move || {
            fault::arm(
                FaultPoint::BeforeFastForwardCheckout,
                Fault::hook(move || {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                }),
            );
            merge_remote(&root)
        }
    });
    entered_rx.recv_timeout(WAIT).unwrap();
    // The competing commit runs on its own worker: once git commands are
    // serialized per graph it blocks until the pull finishes, so the pull
    // must be released without waiting for it.
    let (at_boundary_tx, at_boundary_rx) = mpsc::channel::<()>();
    let (commit_done_tx, commit_done_rx) = mpsc::channel::<()>();
    let commit = thread::spawn({
        let root = root_a.clone();
        move || {
            // Handshake at the commit's entry: past this point the worker is
            // inside `commit_all`, about to take the graph lock (once one
            // exists) and touch the repository.
            fault::arm(
                FaultPoint::BeforeCommit,
                Fault::hook(move || at_boundary_tx.send(()).unwrap()),
            );
            let outcome = commit_all(&root, "Update notes", MAX_FILE_BYTES);
            let _ = commit_done_tx.send(());
            outcome
        }
    });
    at_boundary_rx
        .recv_timeout(WAIT)
        .expect("the competing commit never reached the repository boundary");
    // From the boundary, two outcomes are possible and both are the race
    // under test: the commit completes inside the window (today: it sees the
    // moved ref over the stale tree and commits the revert), or it blocks on
    // the graph lock until the pull finishes (once commands are serialized),
    // in which case this bounded wait times out and the pull is released.
    let _ = commit_done_rx.recv_timeout(Duration::from_secs(2));
    resume_tx.send(()).unwrap();
    pull.join().unwrap().unwrap();
    commit.join().unwrap().unwrap();

    assert_next_cycle_keeps_pulled_notes(&fixture);
}

#[test]
fn merge_interrupted_before_commit_converges_next_cycle() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/a2.md", "# A2\n");
    commit_all(root_a, "a2", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();

    // The process dies after the merge is resolved in memory.
    fault::arm(FaultPoint::BeforeMergeCommit, Fault::Panic);
    let crashed = std::panic::catch_unwind(AssertUnwindSafe(|| merge_remote(root_a)));
    assert!(crashed.is_err(), "the injected crash must unwind");

    // The next cycle needs no manual repair and loses nothing.
    commit_all(root_a, "Update notes", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    merge_remote(root_a).unwrap();
    assert!(push(root_a, None).unwrap().pushed);
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    for (rel, expected) in [
        ("notes/a.md", "# A\n"),
        ("notes/a2.md", "# A2\n"),
        ("notes/b.md", "# B\n"),
    ] {
        assert_eq!(read(root_a, rel), expected, "{rel} on disk");
        assert_eq!(head_blob(root_a, rel), expected, "{rel} in HEAD");
        assert_eq!(remote_blob(&fixture, rel), expected, "{rel} on the remote");
    }
}

/// Device A and device B each committed a different note on top of a shared
/// base, and A has fetched B's commit, so the next pull is a true merge.
fn diverged_fixture() -> Fixture {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    write(root_a, "notes/shared.md", SHARED_BASE);
    commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    write(&root_b, "notes/shared.md", SHARED_FROM_B);
    commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/a2.md", "# A2\n");
    commit_all(root_a, "a2", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    fixture
}

const SHARED_BASE: &str = "# Shared\n\ntop\n\nmiddle\n\nbottom\n";
const SHARED_FROM_B: &str = "# Shared\n\ntop\n\nmiddle\n\nbottom edited on b\n";

/// Run the normal cycle and assert that every expected file is on disk, in
/// `HEAD`, and on the remote, and that the repository is not mid-operation.
fn assert_next_cycle_converges(fixture: &Fixture, expected: &[(&str, &str)]) {
    let root_a = &fixture.graph_a;
    commit_all(root_a, "Update notes", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    merge_remote(root_a).unwrap();
    assert!(push(root_a, None).unwrap().pushed);
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(!root_a.join(".git/MERGE_HEAD").exists());
    for (rel, expected) in expected {
        assert_eq!(read(root_a, rel), *expected, "{rel} on disk");
        assert_eq!(head_blob(root_a, rel), *expected, "{rel} in HEAD");
        assert_eq!(remote_blob(fixture, rel), *expected, "{rel} on the remote");
    }
}

const DIVERGED_RESULT: &[(&str, &str)] = &[
    ("notes/a.md", "# A\n"),
    ("notes/a2.md", "# A2\n"),
    ("notes/b.md", "# B\n"),
    ("notes/shared.md", SHARED_FROM_B),
];

/// Like [`diverged_fixture`], but both devices also edited the same line of
/// `notes/conflict.md`, so the merge runs the ladder on it.
fn conflicting_fixture() -> Fixture {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    write(root_a, "notes/conflict.md", "# Conflict\n\noriginal line\n");
    commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    write(
        &root_b,
        "notes/conflict.md",
        "# Conflict\n\nedited on bravo\n",
    );
    commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(
        root_a,
        "notes/conflict.md",
        "# Conflict\n\nedited on alpha\n",
    );
    commit_all(root_a, "a edit", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    fixture
}

/// The ladder's text for `notes/conflict.md` in the recorded merge commit,
/// checked to hold both sides and no markers.
fn recorded_conflict_text(root: &Path, merge: git2::Oid) -> String {
    let repo = Repository::open(root).unwrap();
    let tree = repo.find_commit(merge).unwrap().tree().unwrap();
    let entry = tree.get_path(Path::new("notes/conflict.md")).unwrap();
    let blob = repo.find_blob(entry.id()).unwrap();
    let content = String::from_utf8(blob.content().to_vec()).unwrap();
    assert_merged_without_markers(&content, &["# Conflict", "alpha", "bravo"]);
    content
}

fn conflicting_result(merged: &str) -> [(&str, &str); 3] {
    [
        ("notes/a.md", "# A\n"),
        ("notes/b.md", "# B\n"),
        ("notes/conflict.md", merged),
    ]
}

fn recorded_merge(root: &Path) -> Option<git2::Oid> {
    Repository::open(root)
        .unwrap()
        .refname_to_id("refs/reflect/merge")
        .ok()
}

/// `HEAD` is the recorded merge or descends from it.
fn assert_head_contains(root: &Path, merge: git2::Oid) {
    let repo = Repository::open(root).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    assert!(
        head == merge || repo.graph_descendant_of(head, merge).unwrap(),
        "HEAD {head} does not contain the recorded merge {merge}"
    );
}

#[test]
fn merge_crash_before_checkout_converges_next_cycle() {
    let fixture = diverged_fixture();
    fault::arm(FaultPoint::AfterMergeCommitBeforeCheckout, Fault::Fail);
    assert!(merge_remote(&fixture.graph_a).is_err());
    assert!(!fixture.graph_a.join("notes/b.md").exists());
    assert_next_cycle_converges(&fixture, DIVERGED_RESULT);
    assert_eq!(recorded_merge(&fixture.graph_a), None);

    let fixture = conflicting_fixture();
    let root_a = &fixture.graph_a;
    fault::arm(FaultPoint::AfterMergeCommitBeforeCheckout, Fault::Fail);
    assert!(merge_remote(root_a).is_err());
    let merge = recorded_merge(root_a).expect("the merge commit is recorded");
    assert_eq!(
        read(root_a, "notes/conflict.md"),
        "# Conflict\n\nedited on alpha\n"
    );
    let merged = recorded_conflict_text(root_a, merge);
    assert_next_cycle_converges(&fixture, &conflicting_result(&merged));
    assert_head_contains(root_a, merge);
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn merge_crash_after_checkout_before_ref_move_converges_next_cycle() {
    let fixture = diverged_fixture();
    fault::arm(FaultPoint::BeforeMergeRefMove, Fault::Fail);
    assert!(merge_remote(&fixture.graph_a).is_err());
    // The merged files are on disk while the branch still points at A's commit.
    assert_eq!(read(&fixture.graph_a, "notes/b.md"), "# B\n");
    assert!(!head_tree_paths(&fixture.graph_a).contains(&"notes/b.md".to_string()));
    assert_next_cycle_converges(&fixture, DIVERGED_RESULT);
    assert_eq!(recorded_merge(&fixture.graph_a), None);

    // A merged note that is already on disk is adopted, not merged again.
    let fixture = conflicting_fixture();
    let root_a = &fixture.graph_a;
    fault::arm(FaultPoint::BeforeMergeRefMove, Fault::Fail);
    assert!(merge_remote(root_a).is_err());
    let merge = recorded_merge(root_a).expect("the merge commit is recorded");
    let merged = recorded_conflict_text(root_a, merge);
    assert_eq!(read(root_a, "notes/conflict.md"), merged);
    assert_next_cycle_converges(&fixture, &conflicting_result(&merged));
    assert_head_contains(root_a, merge);
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn an_adopted_merge_reports_its_files() {
    let fixture = diverged_fixture();
    let root_a = &fixture.graph_a;
    fault::arm(FaultPoint::AfterMergeCommitBeforeCheckout, Fault::Fail);
    assert!(merge_remote(root_a).is_err());

    let outcome = merge_remote(root_a).unwrap();
    for rel in ["notes/b.md", "notes/shared.md"] {
        let change = outcome
            .changed_files
            .iter()
            .find(|change| change.path == rel)
            .unwrap_or_else(|| panic!("{rel} is not reported: {outcome:?}"));
        assert!(change.modified_ms.is_some(), "{outcome:?}");
    }
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn a_recorded_merge_from_a_foreign_head_is_dropped() {
    let fixture = diverged_fixture();
    let root_a = &fixture.graph_a;
    {
        let repo = Repository::open(root_a).unwrap();
        let remote = repo
            .find_commit(repo.refname_to_id("refs/remotes/origin/main").unwrap())
            .unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let foreign = repo
            .commit(
                None,
                &sig,
                &sig,
                "foreign",
                &remote.tree().unwrap(),
                &[&remote],
            )
            .unwrap();
        repo.reference("refs/reflect/merge", foreign, true, "test")
            .unwrap();
    }
    assert_next_cycle_converges(&fixture, DIVERGED_RESULT);
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn edits_after_a_merge_crash_survive_the_next_cycle() {
    let fixture = diverged_fixture();
    let root_a = &fixture.graph_a;
    fault::arm(FaultPoint::BeforeMergeRefMove, Fault::Fail);
    assert!(merge_remote(root_a).is_err());
    assert_eq!(read(root_a, "notes/shared.md"), SHARED_FROM_B);

    // The user edits the note the merge just rewrote, before the next cycle.
    let typed = "# Shared\n\ntop typed after the crash\n\nmiddle\n\nbottom edited on b\n";
    write(root_a, "notes/shared.md", typed);

    assert_next_cycle_converges(
        &fixture,
        &[
            ("notes/a.md", "# A\n"),
            ("notes/a2.md", "# A2\n"),
            ("notes/b.md", "# B\n"),
            ("notes/shared.md", typed),
        ],
    );
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn edits_after_a_crash_before_checkout_keep_the_merged_changes() {
    let fixture = diverged_fixture();
    let root_a = &fixture.graph_a;
    fault::arm(FaultPoint::AfterMergeCommitBeforeCheckout, Fault::Fail);
    assert!(merge_remote(root_a).is_err());
    assert_eq!(read(root_a, "notes/shared.md"), SHARED_BASE);

    // The user edits the pre-merge version of a note the merge changed.
    write(
        root_a,
        "notes/shared.md",
        "# Shared\n\ntop typed after the crash\n\nmiddle\n\nbottom\n",
    );

    assert_next_cycle_converges(
        &fixture,
        &[
            ("notes/a.md", "# A\n"),
            ("notes/b.md", "# B\n"),
            (
                "notes/shared.md",
                "# Shared\n\ntop typed after the crash\n\nmiddle\n\nbottom edited on b\n",
            ),
        ],
    );
    assert_eq!(recorded_merge(root_a), None);
}

#[test]
fn a_save_between_commit_and_merge_survives_the_merge() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/shared.md", SHARED_BASE);
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/shared.md", SHARED_FROM_B);
    commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(
        root_a,
        "notes/shared.md",
        "# Shared\n\ntop edited on a\n\nmiddle\n\nbottom\n",
    );
    commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
    // A save lands after the cycle's commit and before the merge.
    write(
        root_a,
        "notes/shared.md",
        "# Shared\n\ntop edited on a\n\nmiddle saved later\n\nbottom\n",
    );
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");

    let expected = "# Shared\n\ntop edited on a\n\nmiddle saved later\n\nbottom edited on b\n";
    assert_eq!(read(root_a, "notes/shared.md"), expected);
    assert_next_cycle_converges(&fixture, &[("notes/shared.md", expected)]);
}

#[test]
fn a_save_between_commit_and_fast_forward_survives() {
    let fixture = pulled_note_fixture();
    let root_a = &fixture.graph_a;
    write(
        root_a,
        "daily/2026-10-01.md",
        "# 2026-10-01 saved\n\n- morning\n",
    );
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");

    let expected = "# 2026-10-01 saved\n\n- morning\n- [[From phone]]\n";
    assert_eq!(read(root_a, "daily/2026-10-01.md"), expected);
    assert_next_cycle_converges(
        &fixture,
        &[
            ("daily/2026-10-01.md", expected),
            ("notes/from-phone.md", PHONE_NOTE),
        ],
    );
}

#[test]
fn a_dirty_save_against_an_overlapping_pull_merges_through_the_ladder() {
    let fixture = pulled_note_fixture();
    let root_a = &fixture.graph_a;
    let rel = "daily/2026-10-01.md";
    // An uncommitted edit rewrites the line the phone's commit also changed.
    let typed = "# 2026-10-01 typed\n\n- morning run\n";
    write(root_a, rel, typed);
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert!(merged.review_paths.is_empty(), "{merged:?}");

    let content = read(root_a, rel);
    assert_merged_without_markers(&content, &["typed", "run", "[[From phone]]"]);
    assert_eq!(head_blob(root_a, rel), PHONE_DAILY);
    // The disk side is in no commit, so a lossy resolution archives it.
    let archive = archived(root_a, rel);
    assert_eq!(archive.len(), 1, "{archive:?}");
    assert_eq!(
        crate::conflict::archive::read(root_a, rel, &archive[0].name).unwrap(),
        typed
    );
}

#[test]
fn a_directory_file_conflict_keeps_the_file_as_a_conflict_copy() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/seed.md", "# Seed\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/x/y.md", "# Y\n");
    commit_all(&root_b, "b dir", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    write(root_a, "notes/x", "file on a\n");
    commit_all(root_a, "a file", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();

    assert!(
        merged
            .review_paths
            .contains(&"notes/x (conflict)".to_string()),
        "{merged:?}"
    );
    assert_eq!(read(root_a, "notes/x/y.md"), "# Y\n");
    assert_eq!(read(root_a, "notes/x (conflict)"), "file on a\n");
    assert_next_cycle_converges(
        &fixture,
        &[
            ("notes/x/y.md", "# Y\n"),
            ("notes/x (conflict)", "file on a\n"),
        ],
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_conflict_keeps_both_sides() {
    use std::os::unix::fs::symlink;

    let fixture = fixture();
    let root_a = &fixture.graph_a;
    symlink("base-target", root_a.join("assets/link")).unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    fs::remove_file(root_b.join("assets/link")).unwrap();
    symlink("b-target", root_b.join("assets/link")).unwrap();
    commit_all(&root_b, "b link", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::remove_file(root_a.join("assets/link")).unwrap();
    symlink("a-target", root_a.join("assets/link")).unwrap();
    commit_all(root_a, "a link", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithReview),
        "{merged:?}"
    );

    assert_eq!(
        fs::read_link(root_a.join("assets/link")).unwrap(),
        Path::new("a-target")
    );
    assert_eq!(
        fs::read_link(root_a.join("assets/link (conflict)")).unwrap(),
        Path::new("b-target")
    );
}

#[test]
fn merge_never_leaves_merge_head() {
    for point in [
        FaultPoint::BeforeMergeCommit,
        FaultPoint::AfterMergeCommitBeforeCheckout,
        FaultPoint::BeforeMergeRefMove,
    ] {
        let fixture = diverged_fixture();
        let root_a = &fixture.graph_a;
        fault::arm(point, Fault::Fail);
        assert!(merge_remote(root_a).is_err(), "{point:?}");
        assert!(!root_a.join(".git/MERGE_HEAD").exists(), "{point:?}");
        let repo = Repository::open(root_a).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean, "{point:?}");
    }
}

fn age_file(path: &Path, minutes: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(std::time::SystemTime::now() - Duration::from_secs(minutes * 60))
        .unwrap();
}

fn commit_with_lock_retry(root: &Path) -> crate::error::AppResult<super::commit::CommitOutcome> {
    super::locks::retry_after_stale_lock(root, || commit_all(root, "sync", MAX_FILE_BYTES))
}

#[test]
fn a_stale_index_lock_is_cleared_and_the_commit_retried() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "one");
    let lock = root.join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    age_file(&lock, 10);

    let outcome = commit_with_lock_retry(root).unwrap();
    assert!(outcome.committed);
    assert!(!lock.exists());
}

#[test]
fn a_fresh_lock_is_left_alone_and_the_error_surfaces() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "one");
    let lock = root.join(".git/index.lock");
    fs::write(&lock, "").unwrap();

    assert!(commit_with_lock_retry(root).is_err());
    assert!(lock.exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_lock_is_never_followed() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "one");
    let outside = tempdir().unwrap();
    let target = outside.path().join("precious");
    fs::write(&target, "keep").unwrap();
    age_file(&target, 10);
    let lock = root.join(".git/index.lock");
    std::os::unix::fs::symlink(&target, &lock).unwrap();

    assert!(commit_with_lock_retry(root).is_err());
    assert!(target.exists());
    assert!(fs::symlink_metadata(&lock).is_ok());
}

#[test]
fn a_lock_path_outside_the_repository_is_never_removed() {
    let fixture = fixture();
    let outside = tempdir().unwrap();
    let stale = outside.path().join("stale.lock");
    fs::write(&stale, "").unwrap();
    age_file(&stale, 10);
    let message = format!(
        "failed to lock file '{}' for writing: the file is locked (code -14)",
        stale.display()
    );

    assert_eq!(
        super::locks::clear_stale_locks(&fixture.graph_a, &message),
        0
    );
    assert!(stale.exists());
}

#[test]
fn a_relative_lock_path_in_the_message_is_ignored() {
    let fixture = fixture();
    let outside = tempdir().unwrap();
    let stale = outside.path().join("stale.lock");
    fs::write(&stale, "").unwrap();
    age_file(&stale, 10);
    let depth = std::env::current_dir().unwrap().components().count();
    let relative = format!(
        "{}{}",
        "../".repeat(depth),
        stale.strip_prefix("/").unwrap().display()
    );
    assert!(Path::new(&relative).exists());
    let message = format!("failed to lock file '{relative}' for writing");

    assert_eq!(
        super::locks::clear_stale_locks(&fixture.graph_a, &message),
        0
    );
    assert!(stale.exists());
}

#[test]
fn remote_head_reports_the_bare_repo_tip() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES).unwrap();
    assert!(push(root, None).unwrap().pushed);

    let other = second_device(&fixture);
    write(&other, "notes/b.md", "# B\n");
    commit_all(&other, "second", MAX_FILE_BYTES).unwrap();
    assert!(push(&other, None).unwrap().pushed);

    let tip = remote_head(root, None).unwrap();
    assert!(tip.remote_oid.is_some());
    assert!(tip.tracking_oid.is_some());
    assert_ne!(tip.remote_oid, tip.tracking_oid);

    fetch(root, None).unwrap();
    let tip = remote_head(root, None).unwrap();
    assert_eq!(tip.remote_oid, tip.tracking_oid);
}

#[test]
fn remote_head_on_an_unborn_remote_is_none() {
    let fixture = fixture();
    let tip = remote_head(&fixture.graph_a, None).unwrap();
    assert_eq!(tip.remote_oid, None);
    assert_eq!(tip.tracking_oid, None);
}

#[test]
fn a_conflict_copy_never_overwrites_an_existing_file() {
    // In the merge index: an untracked file already holds the first name.
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
    fs::write(root_a.join("assets/img (conflict).bin"), b"keep me").unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(
        merged
            .review_paths
            .contains(&"assets/img (conflict 2).bin".to_string()),
        "{merged:?}"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict).bin")).unwrap(),
        b"keep me"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict 2).bin")).unwrap(),
        b"\x00from-b\x01"
    );

    // On checkout: the incoming tree already holds the first name.
    let fixture = fixture_with_pic();
    let root_a = &fixture.graph_a;
    let root_b = second_device(&fixture);
    fs::write(root_b.join("assets/pic.bin"), b"\x00from-b\x01").unwrap();
    fs::write(root_b.join("assets/pic (conflict).bin"), b"\x00tracked\x01").unwrap();
    commit_all(&root_b, "b pic", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    fs::write(root_a.join("assets/pic.bin"), b"\x00from-a\x01").unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(
        merged.review_paths,
        vec!["assets/pic (conflict 2).bin".to_string()]
    );
    assert_eq!(
        fs::read(root_a.join("assets/pic.bin")).unwrap(),
        b"\x00from-a\x01"
    );
    assert_eq!(
        fs::read(root_a.join("assets/pic (conflict).bin")).unwrap(),
        b"\x00tracked\x01"
    );
    assert_eq!(
        fs::read(root_a.join("assets/pic (conflict 2).bin")).unwrap(),
        b"\x00from-b\x01"
    );
}

/// A graph with `assets/pic.bin` committed and pushed.
fn fixture_with_pic() -> Fixture {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    fs::write(root_a.join("assets/pic.bin"), b"\x00base\x01").unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();
    fixture
}

#[cfg(unix)]
#[test]
fn a_locally_changed_symlink_survives_the_pull() {
    use std::os::unix::fs::symlink;

    let fixture = fixture();
    let root_a = &fixture.graph_a;
    symlink("base-target", root_a.join("assets/kept")).unwrap();
    symlink("base-target", root_a.join("assets/both")).unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    fs::remove_file(root_b.join("assets/both")).unwrap();
    symlink("b-target", root_b.join("assets/both")).unwrap();
    commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();

    for name in ["kept", "both"] {
        fs::remove_file(root_a.join("assets").join(name)).unwrap();
        symlink("a-target", root_a.join("assets").join(name)).unwrap();
    }
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");

    assert_eq!(read(root_a, "notes/b.md"), "# B\n");
    for name in ["kept", "both"] {
        assert_eq!(
            fs::read_link(root_a.join("assets").join(name)).unwrap(),
            Path::new("a-target"),
            "{name}"
        );
    }
    assert_eq!(
        fs::read_link(root_a.join("assets/both (conflict)")).unwrap(),
        Path::new("b-target")
    );
    assert_eq!(
        merged.review_paths,
        vec!["assets/both (conflict)".to_string()]
    );
}

#[test]
fn untracked_files_are_left_alone_by_the_pull() {
    let fixture = pulled_note_fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/scratch.md", "# Scratch\n");
    let before = fs::metadata(root_a.join("notes/scratch.md"))
        .unwrap()
        .modified()
        .unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");

    assert!(
        !merged
            .changed_files
            .iter()
            .any(|change| change.path == "notes/scratch.md"),
        "{merged:?}"
    );
    assert_eq!(read(root_a, "notes/scratch.md"), "# Scratch\n");
    let after = fs::metadata(root_a.join("notes/scratch.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn reflect_runtime_files_never_enter_a_merge() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();

    // Another tool on the other device commits the runtime directory.
    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    write(&root_b, ".reflect/index.sqlite", "from b");
    {
        let repo = Repository::open(&root_b).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("notes/b.md")).unwrap();
        index.add_path(Path::new(".reflect/index.sqlite")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = git2::Signature::now("t", "t@t").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "foreign", &tree, &[&parent])
            .unwrap();
    }
    push(&root_b, None).unwrap();

    write(root_a, ".reflect/index.sqlite", "local runtime");
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");

    assert_eq!(read(root_a, "notes/b.md"), "# B\n");
    assert_eq!(read(root_a, ".reflect/index.sqlite"), "local runtime");
    assert!(
        !merged
            .changed_files
            .iter()
            .any(|change| change.path.starts_with(".reflect/")),
        "{merged:?}"
    );
}

#[test]
fn a_local_delete_of_an_incoming_change_is_reported_for_review() {
    let fixture = pulled_note_fixture();
    let root_a = &fixture.graph_a;
    fs::remove_file(root_a.join("daily/2026-10-01.md")).unwrap();
    let merged = merge_remote(root_a).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");

    assert_eq!(read(root_a, "daily/2026-10-01.md"), PHONE_DAILY);
    assert_eq!(merged.review_paths, vec!["daily/2026-10-01.md".to_string()]);
}

const COEXISTING_NOTE: &str = "daily/2026-10-16.md";

fn append_line(root: &Path, line: &str) {
    let mut text = read(root, COEXISTING_NOTE);
    text.push_str(line);
    text.push('\n');
    write(root, COEXISTING_NOTE, &text);
}

fn assert_clean_merge(root: &Path) {
    fetch(root, None).unwrap();
    let merged = merge_remote(root).unwrap();
    assert!(
        matches!(
            merged.kind,
            MergeKind::UpToDate | MergeKind::FastForward | MergeKind::Merged
        ),
        "{merged:?}"
    );
    assert!(merged.review_paths.is_empty(), "{merged:?}");
}

fn sync_device(root: &Path) {
    commit_all(root, "sync", MAX_FILE_BYTES).unwrap();
    assert_clean_merge(root);
    push(root, None).unwrap();
}

fn coexisting_pair() -> (Fixture, std::path::PathBuf) {
    let fixture = fixture();
    write(&fixture.graph_a, COEXISTING_NOTE, "# 2026-10-16\n\n");
    commit_all(&fixture.graph_a, "base", MAX_FILE_BYTES).unwrap();
    push(&fixture.graph_a, None).unwrap();
    let root_b = second_device(&fixture);
    (fixture, root_b)
}

fn assert_converged(fixture: &Fixture, root_b: &Path, lines: &[String]) {
    let root_a = &fixture.graph_a;
    let text = read(root_a, COEXISTING_NOTE);
    assert_eq!(read(root_b, COEXISTING_NOTE), text);
    assert_eq!(head_blob(root_a, COEXISTING_NOTE), text);
    assert_eq!(head_blob(root_b, COEXISTING_NOTE), text);
    assert_eq!(remote_blob(fixture, COEXISTING_NOTE), text);
    for marker in ["<<<<<<<", "=======", ">>>>>>>"] {
        assert!(!text.contains(marker), "{text}");
    }
    let body: Vec<&str> = text.lines().skip(2).collect();
    assert_eq!(body.len(), lines.len(), "{text}");
    for line in lines {
        assert_eq!(body.iter().filter(|got| *got == line).count(), 1, "{text}");
    }
}

#[test]
fn coexisting_devices_converge_without_text_merges() {
    let (fixture, root_b) = coexisting_pair();
    let root_a = &fixture.graph_a;
    let mut lines = Vec::new();
    for round in 0..20 {
        let line = format!("- line {round}");
        let (editor, other) = if round % 2 == 0 {
            (root_a.as_path(), root_b.as_path())
        } else {
            (root_b.as_path(), root_a.as_path())
        };
        append_line(editor, &line);
        copy_note(editor, other, COEXISTING_NOTE);
        commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
        commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
        lines.push(line);
    }

    sync_device(root_a);
    sync_device(&root_b);
    assert_clean_merge(root_a);

    assert_converged(&fixture, &root_b, &lines);
}

#[test]
fn coexisting_devices_with_a_late_icloud_copy_keep_every_line() {
    let (fixture, root_b) = coexisting_pair();
    let root_a = &fixture.graph_a;
    let mut lines = Vec::new();
    for round in 0..20 {
        if round == 10 {
            append_line(root_a, "- late a");
            append_line(&root_b, "- late b");
            commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
            push(root_a, None).unwrap();
            commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
            fetch(&root_b, None).unwrap();
            let merged = merge_remote(&root_b).unwrap();
            assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
            assert!(merged.review_paths.is_empty(), "{merged:?}");
            push(&root_b, None).unwrap();
            copy_note(&root_b, root_a, COEXISTING_NOTE);
            commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
            lines.push("- late a".to_string());
            lines.push("- late b".to_string());
            continue;
        }
        let line = format!("- line {round}");
        let (editor, other) = if round % 2 == 0 {
            (root_a.as_path(), root_b.as_path())
        } else {
            (root_b.as_path(), root_a.as_path())
        };
        append_line(editor, &line);
        copy_note(editor, other, COEXISTING_NOTE);
        commit_all(root_a, "a", MAX_FILE_BYTES).unwrap();
        commit_all(&root_b, "b", MAX_FILE_BYTES).unwrap();
        lines.push(line);
    }

    sync_device(root_a);
    sync_device(&root_b);
    assert_clean_merge(root_a);
    assert_clean_merge(&root_b);

    assert_converged(&fixture, &root_b, &lines);
}
