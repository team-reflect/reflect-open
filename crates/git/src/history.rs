//! Per-note history over the backup repository: the commits that changed one
//! note, newest first, and the note's text at any of them.
//!
//! Read-only: these walk the object database and never touch the index, the
//! working tree or a ref, so they run outside the graph lock (git supports
//! concurrent readers alongside a writer).

use std::collections::HashMap;
use std::path::Path;

use git2::{Delta, Oid, Repository, Sort, Tree};
use serde::Serialize;

use reflect_graph_paths::{is_note, to_slash_lossy};
use reflect_types::{AppError, AppResult};

use super::repo;

/// One commit that changed a note.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRevision {
    pub oid: String,
    /// The note's graph-relative path in this commit; differs from the
    /// requested path for revisions from before a rename.
    pub path: String,
    /// Commit time in epoch ms.
    pub time_ms: i64,
    /// The commit subject (the backup's derived message).
    pub summary: String,
}

/// A page of a note's revisions, newest first.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryPage {
    pub revisions: Vec<NoteRevision>,
    /// Pass back as `after` for the next page; `None` on the last page.
    pub next_cursor: Option<String>,
}

/// The revisions of the note at `path`, newest first: the commits on HEAD's
/// history whose blob for the note differs from every parent's, so a merge
/// that took one side unchanged is not a revision. Every parent is still
/// walked. Renames are followed into older commits. `after` is the
/// `next_cursor` of the previous page.
pub fn note_history(
    root: &Path,
    path: &str,
    after: Option<&str>,
    limit: usize,
) -> AppResult<NoteHistoryPage> {
    let repo = repo::open_existing(root)?;
    let head = match repo.head() {
        Ok(head) => head.peel_to_commit()?,
        Err(err) if err.code() == git2::ErrorCode::UnbornBranch => {
            return Ok(NoteHistoryPage {
                revisions: Vec::new(),
                next_cursor: None,
            });
        }
        Err(err) => return Err(err.into()),
    };
    let after = after.map(Oid::from_str).transpose()?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(head.id())?;

    // The note's path at each commit still to be visited. A topological walk
    // reaches every child before its parents, so a commit's entry is in place
    // by the time the walk gets to it.
    let mut tracked: HashMap<Oid, String> = HashMap::from([(head.id(), path.to_string())]);
    let mut skipping = after.is_some();
    let mut revisions = Vec::new();
    for oid in walk {
        if tracked.is_empty() {
            break;
        }
        let oid = oid?;
        let Some(path) = tracked.remove(&oid) else {
            continue;
        };
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let blob = blob_at(&tree, &path);
        let mut changed = blob.is_some();
        for parent in commit.parents() {
            let parent_tree = parent.tree()?;
            let Some(parent_path) = path_in_parent(&repo, &parent_tree, &tree, &path)? else {
                continue;
            };
            if blob.is_some() && blob_at(&parent_tree, &parent_path) == blob {
                changed = false;
            }
            tracked.entry(parent.id()).or_insert(parent_path);
        }
        if !changed {
            continue;
        }
        if skipping {
            skipping = Some(oid) != after;
            continue;
        }
        if revisions.len() == limit {
            let next_cursor = revisions
                .last()
                .map(|revision: &NoteRevision| revision.oid.clone());
            return Ok(NoteHistoryPage {
                revisions,
                next_cursor,
            });
        }
        revisions.push(NoteRevision {
            oid: oid.to_string(),
            path,
            time_ms: commit.time().seconds() * 1000,
            summary: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(NoteHistoryPage {
        revisions,
        next_cursor: None,
    })
}

/// The note's text at `revision` (a commit oid, or `HEAD`), where it lived at
/// `path`. Only notes can be read, never other tracked files.
pub fn note_at_revision(root: &Path, revision: &str, path: &str) -> AppResult<String> {
    if !is_note(path) {
        return Err(AppError::traversal(format!("{path} is not a note")));
    }
    let repo = repo::open_existing(root)?;
    let tree = repo.revparse_single(revision)?.peel_to_commit()?.tree()?;
    let Some(blob_id) = blob_at(&tree, path) else {
        return Err(AppError::not_found(format!(
            "{path} is not in revision {revision}"
        )));
    };
    let blob = repo.find_blob(blob_id)?;
    String::from_utf8(blob.content().to_vec())
        .map_err(|_| AppError::parse(format!("{path} in revision {revision} is not UTF-8 text")))
}

fn blob_at(tree: &Tree<'_>, path: &str) -> Option<Oid> {
    tree.get_path(Path::new(path)).ok().map(|entry| entry.id())
}

/// Where the note at `path` in `tree` lived in `parent_tree`: the same path,
/// the source of a rename that produced it, or `None` when the commit added it.
fn path_in_parent(
    repo: &Repository,
    parent_tree: &Tree<'_>,
    tree: &Tree<'_>,
    path: &str,
) -> AppResult<Option<String>> {
    if blob_at(parent_tree, path).is_some() {
        return Ok(Some(path.to_string()));
    }
    let mut diff = repo.diff_tree_to_tree(Some(parent_tree), Some(tree), None)?;
    diff.find_similar(None)?;
    Ok(diff
        .deltas()
        .filter(|delta| delta.status() == Delta::Renamed)
        .find(|delta| delta.new_file().path().map(to_slash_lossy).as_deref() == Some(path))
        .and_then(|delta| delta.old_file().path().map(to_slash_lossy)))
}

#[cfg(test)]
mod history_tests {
    use std::fs;

    use reflect_types::AppError;

    use super::{note_at_revision, note_history};
    use crate::MAX_FILE_BYTES;
    use crate::commit::commit_all;
    use crate::merge::merge_remote;
    use crate::remote::{fetch, push};
    use crate::test_support::{fixture, second_device, write};

    fn commit(root: &std::path::Path) -> String {
        commit_all(root, "Update notes", MAX_FILE_BYTES)
            .unwrap()
            .sha
            .unwrap()
    }

    #[test]
    fn lists_only_commits_that_changed_the_note_newest_first() {
        let fixture = fixture();
        let root = &fixture.graph_a;
        write(root, "notes/a.md", "# A\n\none\n");
        let first = commit(root);
        write(root, "notes/b.md", "# B\n");
        commit(root);
        write(root, "notes/a.md", "# A\n\ntwo\n");
        let second = commit(root);

        let page = note_history(root, "notes/a.md", None, 10).unwrap();
        let oids: Vec<&str> = page.revisions.iter().map(|rev| rev.oid.as_str()).collect();
        assert_eq!(oids, [second.as_str(), first.as_str()]);
        assert_eq!(page.revisions[0].summary, "Update A");
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn reads_the_note_text_at_a_revision() {
        let fixture = fixture();
        let root = &fixture.graph_a;
        write(root, "notes/a.md", "# A\n\none\n");
        let first = commit(root);
        write(root, "notes/a.md", "# A\n\ntwo\n");
        commit(root);

        assert_eq!(
            note_at_revision(root, &first, "notes/a.md").unwrap(),
            "# A\n\none\n"
        );
        assert!(note_at_revision(root, &first, "notes/missing.md").is_err());
        assert_eq!(
            note_at_revision(root, "HEAD", "notes/a.md").unwrap(),
            "# A\n\ntwo\n"
        );
    }

    #[test]
    fn reads_only_notes() {
        let fixture = fixture();
        let root = &fixture.graph_a;
        write(root, "notes/a.md", "# A\n");
        write(root, "notes/data.txt", "secret\n");
        let sha = commit(root);

        for path in ["notes/data.txt", "../notes/a.md"] {
            assert!(matches!(
                note_at_revision(root, &sha, path),
                Err(AppError::Traversal { .. })
            ));
        }
    }

    #[test]
    fn pages_with_a_cursor() {
        let fixture = fixture();
        let root = &fixture.graph_a;
        let mut shas = Vec::new();
        for edit in 0..5 {
            write(root, "notes/a.md", &format!("# A\n\n{edit}\n"));
            shas.push(commit(root));
        }
        shas.reverse();

        let first = note_history(root, "notes/a.md", None, 2).unwrap();
        let second = note_history(root, "notes/a.md", first.next_cursor.as_deref(), 2).unwrap();
        let third = note_history(root, "notes/a.md", second.next_cursor.as_deref(), 2).unwrap();
        assert!(third.next_cursor.is_none());
        let oids: Vec<String> = [first, second, third]
            .into_iter()
            .flat_map(|page| page.revisions.into_iter().map(|rev| rev.oid))
            .collect();
        assert_eq!(oids, shas);
    }

    #[test]
    fn follows_a_rename_into_older_revisions() {
        let fixture = fixture();
        let root = &fixture.graph_a;
        let body = "A long enough body that the file stays similar across the rename.\n";
        write(
            root,
            "notes/01j.md",
            &format!("---\nid: 01j\n---\n# Untitled\n\n{body}"),
        );
        let born = commit(root);
        // A title edit renames the file (Plan 17): both land in one commit.
        fs::remove_file(root.join("notes/01j.md")).unwrap();
        write(
            root,
            "notes/atlas.md",
            &format!("---\nid: 01j\n---\n# Atlas\n\n{body}"),
        );
        let renamed = commit(root);

        let page = note_history(root, "notes/atlas.md", None, 10).unwrap();
        let revisions: Vec<(&str, &str)> = page
            .revisions
            .iter()
            .map(|rev| (rev.oid.as_str(), rev.path.as_str()))
            .collect();
        assert_eq!(
            revisions,
            [
                (renamed.as_str(), "notes/atlas.md"),
                (born.as_str(), "notes/01j.md")
            ]
        );
    }

    #[test]
    fn a_merge_that_took_one_side_is_not_a_revision() {
        let fixture = fixture();
        let root_a = &fixture.graph_a;
        write(root_a, "notes/a.md", "# A\n\nbase\n");
        commit(root_a);
        push(root_a, None).unwrap();

        let root_b = second_device(&fixture);
        write(&root_b, "notes/a.md", "# A\n\nfrom b\n");
        let from_b = commit(&root_b);
        push(&root_b, None).unwrap();

        write(root_a, "notes/other.md", "# Other\n");
        commit(root_a);
        fetch(root_a, None).unwrap();
        merge_remote(root_a).unwrap();

        let page = note_history(root_a, "notes/a.md", None, 10).unwrap();
        assert_eq!(page.revisions.len(), 2);
        assert_eq!(page.revisions[0].oid, from_b);
    }

    #[test]
    fn an_unborn_repository_has_no_history() {
        let fixture = fixture();
        let page = note_history(&fixture.graph_a, "notes/a.md", None, 10).unwrap();
        assert!(page.revisions.is_empty());
    }
}
