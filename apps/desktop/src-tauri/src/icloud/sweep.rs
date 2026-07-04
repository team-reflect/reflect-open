//! The conflict sweep (Plan 21 Phase 2): walk the graph, resolve every
//! iCloud conflict through the deterministic ladder, and report what changed
//! so the caller reindexes directly (never waiting on the watcher — the same
//! contract as the Git merge path).
//!
//! Per conflicted note: archive **every** involved version first (resolution
//! must never be the only copy-holder), fold the conflict versions through
//! [`crate::conflict::ladder`], write the result atomically, then — and only
//! then — mark the provider versions resolved. Creation-collision duplicates
//! (`2026-07-04 2.md`, iCloud's rename when two devices create the same
//! filename apart) are folded back into their canonical file by the same
//! ladder with the union rule enabled.
//!
//! Shadow-base bookkeeping rides the sweep: bases advance on resolutions and
//! on the clean external ingests the frontend reports (`ingested_paths`),
//! and `record_baseline` snapshots a graph on iCloud adoption — never on
//! local saves (see [`crate::conflict::shadow`]).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::conflict::ladder::{self, ConflictInput};
use crate::conflict::shadow::{content_hash, ShadowStore};
use crate::conflict::{archive, ConflictSide, Resolution};
use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

use super::versions::{mark_resolved, unresolved_versions, VersionRef};

/// The label for the side that lives in this device's working file. Device
/// names for the *other* side come from the provider's version metadata;
/// there is no equally reliable local twin, so the fallback label stands in.
/// (Marker output containing it differs between two devices racing the same
/// conflict; the marked-side rule converges them one round later.)
const LOCAL_LABEL: &str = "this device";

/// One file the sweep rewrote or removed, in the watcher's change shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    /// `"upsert"` or `"remove"` (removes are folded collision duplicates).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

/// What one sweep did.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepOutcome {
    /// Every file the sweep changed on disk — reindex these directly.
    pub changed: Vec<SweepChange>,
    /// Paths now carrying conflict markers ("Needs review").
    pub needs_review: Vec<String>,
    /// Conflicted paths skipped because the caller holds a dirty editor
    /// session for them; retried on the next sweep after the flush.
    pub deferred: Vec<String>,
    /// Conflicts resolved without user interaction.
    pub auto_resolved: u32,
}

/// Command: run a conflict sweep over the generation-pinned graph.
///
/// `skip_paths` — notes with dirty open sessions (the session's own conflict
/// parking covers them until flushed). `ingested_paths` — external changes
/// the frontend just applied cleanly; their content becomes the new shadow
/// base. `record_baseline` — snapshot every conflict-free note as its own
/// base (iCloud adoption).
#[tauri::command]
pub async fn icloud_conflicts_scan(
    generation: u64,
    skip_paths: Vec<String>,
    ingested_paths: Vec<String>,
    record_baseline: bool,
    state: State<'_, GraphState>,
) -> AppResult<SweepOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_sweep(&root, &skip_paths, &ingested_paths, record_baseline)
    })
    .await
    .map_err(|err| AppError::io(err.to_string()))?
}

/// The sweep body (blocking). Pure fs + ladder logic apart from the
/// `NSFileVersion` calls, which no-op off Apple platforms.
fn run_sweep(
    root: &Path,
    skip_paths: &[String],
    ingested_paths: &[String],
    record_baseline: bool,
) -> AppResult<SweepOutcome> {
    let shadow = ShadowStore::new(root);
    let skip: BTreeSet<&str> = skip_paths.iter().map(String::as_str).collect();
    let mut outcome = SweepOutcome::default();

    for rel in ingested_paths {
        advance_base_if_clean(root, rel, &shadow);
    }

    let files = crate::fs::note_files(root)?;

    if record_baseline {
        for file in &files {
            if !file.placeholder {
                advance_base_if_clean(root, &file.path, &shadow);
            }
        }
    }

    fold_collision_duplicates(root, &files, &shadow, &skip, &mut outcome);

    for file in &files {
        if file.placeholder {
            continue;
        }
        let abs = root.join(&file.path);
        let versions = unresolved_versions(&abs);
        if versions.is_empty() {
            continue;
        }
        if skip.contains(file.path.as_str()) {
            outcome.deferred.push(file.path.clone());
            continue;
        }
        match resolve_file(root, &file.path, file.modified_ms, versions, &shadow) {
            Ok(resolved) => apply_file_resolution(root, &file.path, resolved, &mut outcome),
            Err(err) => {
                // One bad note must not stop the sweep; versions stay
                // unresolved and the next sweep retries it.
                tracing::warn!(path = %file.path, ?err, "conflict resolution failed");
            }
        }
    }

    archive::prune(root);
    Ok(outcome)
}

/// A clean external ingest (or adoption snapshot): the note's disk content is
/// now what both sides derive from — record it as the base. Skips notes that
/// currently carry unresolved versions (mid-conflict content is nobody's
/// ancestor) and non-UTF-8/missing files.
fn advance_base_if_clean(root: &Path, rel: &str, shadow: &ShadowStore) {
    let abs = root.join(rel);
    if !unresolved_versions(&abs).is_empty() {
        return;
    }
    let Ok(content) = fs::read_to_string(&abs) else {
        return;
    };
    if let Err(err) = shadow.record(rel, &content) {
        tracing::warn!(path = rel, ?err, "failed to record shadow base");
    }
}

/// What [`resolve_file`] decided for one conflicted note.
struct FileResolution {
    final_content: String,
    changed: bool,
    marked: bool,
}

/// Fold a note's unresolved versions through the ladder, oldest first.
/// Archives every side before anything else. Does not touch the provider's
/// version state — the caller does, after the resolved write lands.
fn resolve_file(
    root: &Path,
    rel: &str,
    file_modified_ms: u64,
    mut versions: Vec<VersionRef>,
    shadow: &ShadowStore,
) -> AppResult<FileResolution> {
    let abs = root.join(rel);
    let original = fs::read_to_string(&abs)
        .map_err(|err| AppError::io(format!("unreadable conflicted note {rel}: {err}")))?;

    archive::archive_version(root, rel, None, file_modified_ms, original.as_bytes())?;
    versions.sort_by_key(|version| version.modified_ms);
    let mut sides: Vec<ConflictSide> = Vec::new();
    for version in &versions {
        let content = fs::read_to_string(&version.store_path).map_err(|err| {
            AppError::io(format!("unreadable conflict version for {rel}: {err}"))
        })?;
        archive::archive_version(
            root,
            rel,
            version.device.as_deref(),
            version.modified_ms,
            content.as_bytes(),
        )?;
        sides.push(ConflictSide {
            content,
            label: version
                .device
                .clone()
                .unwrap_or_else(|| "other device".to_string()),
            modified_ms: version.modified_ms,
        });
    }

    let base = shadow.base(rel);
    let mut current = ConflictSide {
        content: original.clone(),
        label: LOCAL_LABEL.to_string(),
        modified_ms: file_modified_ms,
    };
    let mut marked = false;
    for side in sides {
        let current_hash = content_hash(&current.content);
        let side_hash = content_hash(&side.content);
        let input = ConflictInput {
            path: rel,
            base: base.as_deref(),
            sides: (current.clone(), side),
            creation_collision: false,
            merge_loop_detected: shadow.is_repeated_merge(rel, &current_hash, &side_hash),
        };
        match ladder::resolve(input)? {
            Resolution::AlreadyResolved => {}
            Resolution::Merged { content } => {
                if content != current.content {
                    // A genuinely synthesized merge: remember the pair so a
                    // cross-device re-conflict of two merge results is
                    // recognized and broken deterministically.
                    let _ = shadow.record_merge_pair(rel, &current_hash, &side_hash);
                }
                current.content = content;
            }
            Resolution::Marked { content } => {
                current.content = content;
                marked = true;
            }
        }
    }

    Ok(FileResolution {
        changed: current.content != original,
        final_content: current.content,
        marked,
    })
}

/// Write a resolution to disk, settle the provider's version state, and do
/// the shadow bookkeeping.
fn apply_file_resolution(
    root: &Path,
    rel: &str,
    resolution: FileResolution,
    outcome: &mut SweepOutcome,
) {
    let abs = root.join(rel);
    let shadow = ShadowStore::new(root);
    if resolution.changed {
        if let Err(err) =
            crate::fs::atomic_write_bytes(root, &abs, resolution.final_content.as_bytes())
        {
            tracing::warn!(path = rel, ?err, "failed to write conflict resolution");
            return; // versions stay unresolved; next sweep retries
        }
        outcome.changed.push(SweepChange {
            path: rel.to_string(),
            kind: "upsert".to_string(),
            modified_ms: modified_ms_of(&abs),
        });
    }
    mark_resolved(&abs);
    if resolution.marked {
        // The user hasn't resolved anything yet: the base must not advance,
        // and a stale merge-pair record would mask the next real conflict.
        shadow.clear_merge_pair(rel);
        outcome.needs_review.push(rel.to_string());
    } else {
        // Both devices converge on the resolved content — it is the new base.
        if let Err(err) = shadow.record(rel, &resolution.final_content) {
            tracing::warn!(path = rel, ?err, "failed to advance shadow base");
        }
        outcome.auto_resolved += 1;
    }
}

/// Fold creation-collision duplicates back into their canonical note. iCloud
/// renames the losing side of a same-name creation to `name 2.md` — with
/// deterministic daily filenames that is the *most common* conflict shape.
/// Reflect's own collision suffixes are hyphenated (Plan 17), so the
/// space-digit shape is unambiguously iCloud's.
fn fold_collision_duplicates(
    root: &Path,
    files: &[crate::fs::FileMeta],
    shadow: &ShadowStore,
    skip: &BTreeSet<&str>,
    outcome: &mut SweepOutcome,
) {
    for file in files {
        if file.placeholder {
            continue;
        }
        let Some(canonical_rel) = collision_canonical(&file.path) else {
            continue;
        };
        if skip.contains(file.path.as_str()) || skip.contains(canonical_rel.as_str()) {
            outcome.deferred.push(file.path.clone());
            continue;
        }
        let dup_abs = root.join(&file.path);
        let canonical_abs = root.join(&canonical_rel);
        let Ok(dup_content) = fs::read_to_string(&dup_abs) else {
            continue;
        };
        if !canonical_abs.exists() {
            // The canonical name is free (the winner was deleted/renamed):
            // the duplicate simply takes its place.
            if fs::rename(&dup_abs, &canonical_abs).is_err() {
                continue;
            }
            outcome
                .changed
                .push(remove_change(&file.path));
            outcome.changed.push(SweepChange {
                path: canonical_rel.clone(),
                kind: "upsert".to_string(),
                modified_ms: modified_ms_of(&canonical_abs),
            });
            continue;
        }
        let Ok(canonical_content) = fs::read_to_string(&canonical_abs) else {
            continue;
        };
        if let Err(err) = archive::archive_version(
            root,
            &file.path,
            None,
            file.modified_ms,
            dup_content.as_bytes(),
        ) {
            tracing::warn!(path = %file.path, ?err, "failed to archive collision duplicate");
            continue;
        }
        let input = ConflictInput {
            path: &canonical_rel,
            base: None, // independent creations share no ancestor
            sides: (
                ConflictSide {
                    content: canonical_content.clone(),
                    label: canonical_rel.clone(),
                    modified_ms: modified_ms_of(&canonical_abs).unwrap_or(0),
                },
                ConflictSide {
                    content: dup_content,
                    label: file.path.clone(),
                    modified_ms: file.modified_ms,
                },
            ),
            creation_collision: true,
            merge_loop_detected: false,
        };
        let resolution = match ladder::resolve(input) {
            Ok(resolution) => resolution,
            Err(err) => {
                tracing::warn!(path = %file.path, ?err, "collision merge failed");
                continue;
            }
        };
        let (merged, is_marked) = match resolution {
            Resolution::AlreadyResolved => (canonical_content.clone(), false),
            Resolution::Merged { content } => (content, false),
            Resolution::Marked { content } => (content, true),
        };
        if merged != canonical_content
            && crate::fs::atomic_write_bytes(root, &canonical_abs, merged.as_bytes()).is_err()
        {
            continue; // duplicate stays; next sweep retries
        }
        if fs::remove_file(&dup_abs).is_err() {
            tracing::warn!(path = %file.path, "failed to remove folded collision duplicate");
        }
        outcome.changed.push(remove_change(&file.path));
        if merged != canonical_content {
            outcome.changed.push(SweepChange {
                path: canonical_rel.clone(),
                kind: "upsert".to_string(),
                modified_ms: modified_ms_of(&canonical_abs),
            });
        }
        if is_marked {
            outcome.needs_review.push(canonical_rel.clone());
            shadow.clear_merge_pair(&canonical_rel);
        } else {
            outcome.auto_resolved += 1;
            if let Err(err) = shadow.record(&canonical_rel, &merged) {
                tracing::warn!(path = %canonical_rel, ?err, "failed to advance shadow base");
            }
        }
    }
}

/// `daily/2026-07-04 2.md` → `Some("daily/2026-07-04.md")`; `None` for
/// anything that isn't an iCloud collision name. Deliberately strict — a
/// single digit 2–9 — because ` <number>` endings are common in real note
/// titles ("top 10", "chapter 1") while an iCloud collision reaching double
/// digits would take nine simultaneous same-name creations.
fn collision_canonical(rel: &str) -> Option<String> {
    let stem = rel.strip_suffix(".md")?;
    let (base, suffix) = stem.rsplit_once(' ')?;
    if base.is_empty() || base.ends_with('/') {
        return None;
    }
    let mut digits = suffix.chars();
    let (Some(digit), None) = (digits.next(), digits.next()) else {
        return None;
    };
    if !('2'..='9').contains(&digit) {
        return None;
    }
    Some(format!("{base}.md"))
}

fn remove_change(rel: &str) -> SweepChange {
    SweepChange {
        path: rel.to_string(),
        kind: "remove".to_string(),
        modified_ms: None,
    }
}

fn modified_ms_of(abs: &Path) -> Option<u64> {
    abs.metadata().ok().as_ref().and_then(crate::fs::modified_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conflict::markers;
    use tempfile::tempdir;

    fn graph() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        for sub in ["daily", "notes", ".reflect"] {
            fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        fs::write(root.join(rel), content).unwrap();
    }

    #[test]
    fn collision_names_parse_strictly() {
        assert_eq!(
            collision_canonical("daily/2026-07-04 2.md"),
            Some("daily/2026-07-04.md".to_string())
        );
        assert_eq!(
            collision_canonical("notes/meeting 9.md"),
            Some("notes/meeting.md".to_string())
        );
        // Not collisions: Plan 17 hyphen suffixes, plain names, and the
        // number-bearing titles users actually write.
        assert_eq!(collision_canonical("notes/meeting-2.md"), None);
        assert_eq!(collision_canonical("notes/meeting.md"), None);
        assert_eq!(collision_canonical("notes/top 10.md"), None);
        assert_eq!(collision_canonical("notes/chapter 1.md"), None);
        assert_eq!(collision_canonical("notes/version 02.md"), None);
    }

    #[test]
    fn daily_collision_duplicates_union_into_the_canonical_file() {
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "# Day\n\n- from mac\n");
        write(root.path(), "daily/2026-07-04 2.md", "# Day\n\n- from phone\n");

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert_eq!(outcome.auto_resolved, 1);
        assert!(outcome.needs_review.is_empty());
        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# Day\n\n- from mac\n- from phone\n"
        );
        // The duplicate's content is archived, not just deleted.
        let archive_dir = root
            .path()
            .join(".reflect/conflict-archive/daily/2026-07-04 2.md");
        assert_eq!(fs::read_dir(archive_dir).unwrap().count(), 1);
        // Changes report the remove + the rewrite for direct reindexing.
        let kinds: Vec<(&str, &str)> = outcome
            .changed
            .iter()
            .map(|change| (change.path.as_str(), change.kind.as_str()))
            .collect();
        assert!(kinds.contains(&("daily/2026-07-04 2.md", "remove")));
        assert!(kinds.contains(&("daily/2026-07-04.md", "upsert")));
    }

    #[test]
    fn an_orphaned_duplicate_takes_the_free_canonical_name() {
        let root = graph();
        write(root.path(), "daily/2026-07-04 2.md", "- phone only\n");

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert!(root.path().join("daily/2026-07-04.md").exists());
        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        assert_eq!(outcome.needs_review.len(), 0);
    }

    #[test]
    fn overlapping_collision_bodies_mark_the_canonical_for_review() {
        let root = graph();
        // The tails overlap ("- common tail" follows both divergent lines) —
        // the union guard refuses, so the canonical file ends up marked, and
        // the labels are the two filenames the content came from.
        write(root.path(), "notes/topic.md", "- shared\n- mac wording\n- common tail\n");
        write(
            root.path(),
            "notes/topic 2.md",
            "- shared\n- phone wording\n- common tail\n",
        );

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert_eq!(outcome.needs_review, vec!["notes/topic.md".to_string()]);
        let merged = fs::read_to_string(root.path().join("notes/topic.md")).unwrap();
        assert!(markers::contains_conflict_markers(&merged));
        assert!(merged.contains("notes/topic.md") && merged.contains("notes/topic 2.md"));
    }

    #[test]
    fn skip_paths_defer_collision_folding() {
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "- a\n");
        write(root.path(), "daily/2026-07-04 2.md", "- b\n");

        let outcome = run_sweep(
            root.path(),
            &["daily/2026-07-04.md".to_string()],
            &[],
            false,
        )
        .unwrap();

        assert_eq!(outcome.deferred, vec!["daily/2026-07-04 2.md".to_string()]);
        assert!(root.path().join("daily/2026-07-04 2.md").exists());
    }

    #[test]
    fn baseline_and_ingest_record_shadow_bases() {
        let root = graph();
        write(root.path(), "notes/a.md", "# A\n");
        write(root.path(), "notes/b.md", "# B\n");

        run_sweep(root.path(), &[], &[], true).unwrap();
        let shadow = ShadowStore::new(root.path());
        assert_eq!(shadow.base("notes/a.md"), Some("# A\n".to_string()));

        write(root.path(), "notes/b.md", "# B updated externally\n");
        run_sweep(root.path(), &[], &["notes/b.md".to_string()], false).unwrap();
        assert_eq!(
            shadow.base("notes/b.md"),
            Some("# B updated externally\n".to_string())
        );
    }

    #[test]
    fn resolve_file_folds_synthetic_versions_through_the_ladder() {
        // VersionRefs are just paths — fabricate a conflict version the way
        // the version store would hold it and run the real fold.
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "- seed\n- mac line\n");
        let store = root.path().join(".reflect/fake-version-store.md");
        fs::write(&store, "- seed\n- phone line\n").unwrap();
        let shadow = ShadowStore::new(root.path());
        shadow.record("daily/2026-07-04.md", "- seed\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "daily/2026-07-04.md",
            2_000,
            vec![VersionRef {
                store_path: store,
                modified_ms: 1_000,
                device: Some("Alex's iPhone".to_string()),
            }],
            &shadow,
        )
        .unwrap();

        assert!(resolution.changed);
        assert!(!resolution.marked);
        // Union order is by version timestamp: the phone side (1000) is older
        // than the file (2000), so its line lands first.
        assert_eq!(
            resolution.final_content,
            "- seed\n- phone line\n- mac line\n"
        );
        // Both originals are archived before anything is written.
        let archived = root
            .path()
            .join(".reflect/conflict-archive/daily/2026-07-04.md");
        assert_eq!(fs::read_dir(archived).unwrap().count(), 2);
    }

    #[test]
    fn resolve_file_marks_overlapping_edits_and_labels_the_device() {
        let root = graph();
        write(root.path(), "notes/a.md", "shared line mac\n");
        let store = root.path().join(".reflect/fake-store.md");
        fs::write(&store, "shared line phone\n").unwrap();
        let shadow = ShadowStore::new(root.path());
        shadow.record("notes/a.md", "shared line\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "notes/a.md",
            1_000,
            vec![VersionRef {
                store_path: store,
                modified_ms: 2_000,
                device: Some("Alex's iPhone".to_string()),
            }],
            &shadow,
        )
        .unwrap();

        assert!(resolution.marked);
        assert!(markers::contains_conflict_markers(&resolution.final_content));
        assert!(resolution.final_content.contains("Alex's iPhone"));
        assert!(resolution.final_content.contains(LOCAL_LABEL));
    }
}
