//! Shared fixtures for the git tests: tempdir graphs and a local bare
//! "remote" (libgit2's local transport, so no network and no credentials,
//! but the same code paths as HTTPS apart from auth).

use std::fs;
use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions};
use tempfile::{tempdir, TempDir};

use super::setup;

/// Scaffold a minimal graph layout (what `fs::bootstrap` produces).
pub(super) fn scaffold_graph(root: &Path) {
    for dir in ["daily", "notes", "assets", ".reflect"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    fs::write(
        root.join(".gitignore"),
        crate::graph_gitignore::default_contents(),
    )
    .unwrap();
    fs::write(root.join(".reflect/index.sqlite"), "not a real db").unwrap();
}

pub(super) fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

pub(super) fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

pub(super) fn head_message(root: &Path) -> String {
    let repo = Repository::open(root).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.message().unwrap().trim().to_string()
}

/// A bare remote + a primary graph connected to it.
pub(super) struct Fixture {
    pub(super) _dir: TempDir,
    pub(super) remote_url: String,
    pub(super) graph_a: PathBuf,
}

pub(super) fn fixture() -> Fixture {
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
pub(super) fn second_device(fixture: &Fixture) -> PathBuf {
    let root = fixture._dir.path().join("graph-b");
    Repository::clone(&fixture.remote_url, &root).unwrap();
    root
}

/// Blob paths in HEAD's tree, in walk order.
pub(super) fn head_tree_paths(root: &Path) -> Vec<String> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    tree_paths(&tree)
}

/// The blob at `rel` in HEAD's tree, as text.
pub(super) fn head_blob(root: &Path, rel: &str) -> String {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    tree_blob(&repo, &tree, rel)
}

/// The blob at `rel` in the bare remote's `main` tree, as text.
pub(super) fn remote_blob(fixture: &Fixture, rel: &str) -> String {
    let repo = Repository::open_bare(&fixture.remote_url).unwrap();
    let tree = repo
        .find_reference("refs/heads/main")
        .unwrap()
        .peel_to_tree()
        .unwrap();
    tree_blob(&repo, &tree, rel)
}

fn tree_blob(repo: &Repository, tree: &git2::Tree<'_>, rel: &str) -> String {
    let entry = tree
        .get_path(Path::new(rel))
        .unwrap_or_else(|_| panic!("{rel} is missing from the tree"));
    let blob = repo.find_blob(entry.id()).unwrap();
    String::from_utf8(blob.content().to_vec()).unwrap()
}

fn tree_paths(tree: &git2::Tree<'_>) -> Vec<String> {
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
