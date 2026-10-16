//! The conflict sweep (Plan 21 Phase 2): walk the graph, resolve every
//! iCloud conflict, and report what changed so the caller reindexes directly
//! (never waiting on the watcher — the same contract as the Git merge path).
//!
//! Per conflicted note: fold the conflict versions through
//! [`crate::conflict::ladder`]. Then write the result atomically and, only
//! then, mark the provider versions resolved. Per conflicted attachment
//! (any other file type, checked on `Full` sweeps only): keep the working
//! file and write each differing version beside it as a conflict copy, then
//! mark the versions resolved. Creation-collision duplicates
//! (`2026-07-04 2.md`, iCloud's rename when two devices create the same
//! filename apart) are folded back into their canonical file by the same
//! ladder.
//!
//! Shadow-base bookkeeping rides the sweep: bases advance on resolutions and
//! on the clean external ingests the frontend reports (`ingested_paths`),
//! and `record_baseline` snapshots a graph on iCloud adoption — never on
//! local saves (see [`crate::conflict::shadow`]).

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::conflict::copy::copy_path;
use crate::conflict::ladder::{self, ConflictInput};
use crate::conflict::shadow::{blob_hash8_of_file, content_hash, ShadowStore};
use crate::conflict::{ConflictSide, Resolution};
use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

use super::versions::{
    current_version_modified_ms, mark_resolved, unresolved_versions, VersionRef,
};

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
    /// Graph-relative paths of the conflict copies the sweep wrote.
    pub copies: Vec<String>,
    /// Conflicts resolved without user interaction.
    pub auto_resolved: u32,
}

/// How much of the graph a sweep checks for unresolved versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SweepScope {
    /// Check every note, and run the store-housekeeping passes. The backstop
    /// — resume, adoption baseline, and any sweep without a live watch.
    Full,
    /// Restrict the per-note `NSFileVersion` checks to the paths the live
    /// metadata query flags as conflicted
    /// ([`crate::icloud::watch::conflicted_paths`]) — each check is a
    /// synchronous file-coordination round-trip to `fileproviderd`, and a
    /// bulk-sync arrival sweep over a large graph paid one per note for a
    /// listing the query already has. Mobile's signal and arrival sweeps.
    /// Degrades to `Full` whenever the watch cannot answer completely (not
    /// installed, or pre-gather).
    Candidates,
    /// Restrict the version checks to this sweep's `ingested_paths` — the
    /// notes external writes just landed on. Desktop's arrival sweeps: no
    /// metadata watch runs there (see [`crate::icloud::watch`]), and a
    /// conflict whose remote side became the working file is by definition
    /// among the arrivals. A conflict version that never touches the working
    /// file is the resume sweep's (`Full`) job, exactly as for graphs kept
    /// outside the app's container.
    Ingested,
}

/// The version-check candidate set for `scope` ([`run_sweep`]'s
/// `conflict_candidates`): `None` checks every note.
fn conflict_candidates(scope: SweepScope, ingested_paths: &[String]) -> Option<HashSet<String>> {
    match scope {
        SweepScope::Full => None,
        SweepScope::Candidates => crate::icloud::watch::conflicted_paths(),
        SweepScope::Ingested => Some(ingested_paths.iter().cloned().collect()),
    }
}

/// Command: run a conflict sweep over the generation-pinned graph.
///
/// `skip_paths` — notes with dirty open sessions (a dirty open session saves
/// and merges on its own). `ingested_paths` — external changes
/// the frontend just applied cleanly; their content becomes the new shadow
/// base. `record_baseline` — snapshot every conflict-free note as its own
/// base (iCloud adoption). `scope` — how much of the graph the version
/// checks cover ([`SweepScope`]).
#[tauri::command]
pub async fn icloud_conflicts_scan(
    generation: u64,
    skip_paths: Vec<String>,
    ingested_paths: Vec<String>,
    record_baseline: bool,
    scope: SweepScope,
    state: State<'_, GraphState>,
) -> AppResult<SweepOutcome> {
    let started = std::time::Instant::now();
    let root = crate::fs::root_for_generation(&state, generation)?;
    let sweep_root = root.clone();
    let outcome = crate::blocking::run_blocking(move || {
        let candidates = conflict_candidates(scope, &ingested_paths);
        run_sweep(
            &sweep_root,
            &skip_paths,
            &ingested_paths,
            record_baseline,
            candidates,
        )
    })
    .await;
    if let Ok(outcome) = &outcome {
        tracing::info!(
            changed = outcome.changed.len(),
            copies = outcome.copies.len(),
            auto_resolved = outcome.auto_resolved,
            record_baseline,
            scope = ?scope,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "icloud_conflicts_scan"
        );
    }
    // The sweep folds conflict siblings into canonical notes; a cached
    // listing from before those renames would pin the conflict names.
    crate::fs::invalidate_file_catalog(&state, &root);
    outcome
}

/// Run one sweep step under the graph lock.
fn locked(root: &Path, step: impl FnOnce()) {
    let _ = crate::fs::with_graph_lock(root, || {
        step();
        Ok(())
    });
}

/// The sweep body (blocking). Pure fs + ladder logic apart from the
/// `NSFileVersion` calls, which no-op off Apple platforms.
///
/// `conflict_candidates` — when `Some`, the per-note version checks cover
/// only these paths (the metadata query's conflicted set); `None` checks
/// everything. **Only** the version checks scope down: ingest base advances,
/// collision folding, and the baseline all still see the full listing — and
/// the store-housekeeping pass (orphan pruning) runs only
/// on unscoped sweeps, because pruning against anything less than the full
/// live set would drop bases for merely-unlisted notes.
fn run_sweep(
    root: &Path,
    skip_paths: &[String],
    ingested_paths: &[String],
    record_baseline: bool,
    conflict_candidates: Option<HashSet<String>>,
) -> AppResult<SweepOutcome> {
    let shadow = ShadowStore::new(root);
    let skip: BTreeSet<&str> = skip_paths.iter().map(String::as_str).collect();
    let mut outcome = SweepOutcome::default();

    for rel in ingested_paths {
        // A dirty open session may still overwrite this file with content
        // derived from an *older* state — advancing the base to the external
        // revision now would make a later diff3 read that overwrite as "we
        // deleted the other device's lines" and drop them. Stale is the safe
        // direction; the base advances once the session settles.
        if skip.contains(rel.as_str()) {
            continue;
        }
        let clean = no_unresolved_versions(root, rel);
        locked(root, || {
            advance_base_if_clean(root, rel, &shadow, false, clean)
        });
    }

    let (files, attachments) = crate::fs::note_and_attachment_files(root);

    if record_baseline {
        for file in &files {
            if skip.contains(file.path.as_str()) {
                continue; // same dirty-session rule as ingests above
            }
            if !file.placeholder {
                // Fill-only: adoption snapshots notes that have no base yet.
                // Overwriting an existing base here would advance it past
                // unsynced local edits — exactly what the advance rule forbids
                // — so a baseline pass is safe to repeat on every start.
                let clean = no_unresolved_versions(root, &file.path);
                locked(root, || {
                    advance_base_if_clean(root, &file.path, &shadow, true, clean)
                });
            }
        }
    }

    fold_collision_duplicates(root, &files, &shadow, &skip, &mut outcome);

    for file in files.iter().chain(attachments.iter()) {
        if file.placeholder {
            continue;
        }
        if let Some(candidates) = &conflict_candidates {
            if !candidates.contains(&file.path) {
                continue; // the provider says no conflict lives here
            }
        }
        let abs = root.join(&file.path);
        let scan = unresolved_versions(&abs);
        if scan.none() {
            continue;
        }
        if !scan.complete {
            // A version with no readable store path can't be read, and
            // mark_resolved would purge it — skip the whole file instead.
            continue;
        }
        if skip.contains(file.path.as_str()) {
            continue;
        }
        // Order the working copy by the version store's date for it — the
        // metadata the *other* device sees for this same content as a
        // conflict version — never the filesystem mtime, which iCloud does
        // not propagate bit-exactly. Mixed keys would let two devices order
        // the same content pair differently and emit different merged bytes.
        let current_ms = current_version_modified_ms(&abs).unwrap_or(file.modified_ms);
        if !reflect_graph_paths::is_note(&file.path) {
            locked(root, || {
                if copy_conflict_versions(root, &file.path, scan.versions, &mut outcome) {
                    mark_resolved(&abs);
                    outcome.auto_resolved += 1;
                }
            });
            continue;
        }
        locked(root, || {
            match resolve_file(root, &file.path, current_ms, scan.versions, &shadow) {
                Ok(resolved) => {
                    apply_file_resolution(root, &file.path, resolved, &shadow, true, &mut outcome);
                }
                Err(err) => {
                    // One bad note must not stop the sweep; versions stay
                    // unresolved and the next sweep retries it.
                    tracing::warn!(path = %file.path, ?err, "conflict resolution failed");
                }
            }
        });
    }

    // External deletions never route through the store's `forget` — drop
    // bases for notes that no longer exist so the store tracks the graph.
    // The keep-set starts from the listing captured at sweep start, plus
    // every path this sweep itself wrote: collision folding can create a
    // canonical file (and record its base) *after* that listing, and pruning
    // must not eat a base recorded moments earlier in the same pass. Paths
    // this sweep itself *removed* (folded duplicates) leave the set again —
    // they made the pre-sweep listing but their files are gone, and keeping
    // them would strand their bases under `.reflect/sync-base/` for a sweep.
    let mut live: BTreeSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    for change in &outcome.changed {
        if change.kind == "upsert" {
            live.insert(change.path.as_str());
        }
    }
    for change in &outcome.changed {
        if change.kind == "remove"
            && !outcome
                .changed
                .iter()
                .any(|other| other.kind == "upsert" && other.path == change.path)
        {
            live.remove(change.path.as_str());
        }
    }
    // Housekeeping only on unscoped sweeps: `live` is correct either way
    // (built from the full listing above), but pruning is pure maintenance
    // — external deletions' orphaned bases can wait for the next resume's
    // full sweep instead of running on every
    // 30-second arrival sweep of a bulk sync.
    if conflict_candidates.is_none() {
        shadow.prune_orphans(&live);
    }
    Ok(outcome)
}

/// Whether `rel` carries no unresolved provider versions. The lookup is a
/// synchronous provider round trip, so it must run outside the graph lock.
/// Traversal-shaped paths answer `false` without touching the filesystem.
fn no_unresolved_versions(root: &Path, rel: &str) -> bool {
    crate::fs::ensure_relative(rel).is_ok() && unresolved_versions(&root.join(rel)).none()
}

/// A clean external ingest (or adoption snapshot): the note's disk content is
/// now what both sides derive from, so record it as the base. Skips notes
/// that carry unresolved versions (`no_versions` is false; mid-conflict
/// content is nobody's ancestor), and non-UTF-8 or missing files. `fill_only` restricts the write to notes without a base
/// (the adoption case).
fn advance_base_if_clean(
    root: &Path,
    rel: &str,
    shadow: &ShadowStore,
    fill_only: bool,
    no_versions: bool,
) {
    // `ingested_paths` arrive over IPC: refuse traversal shapes before any
    // filesystem access, like every other IPC-supplied graph path.
    if !no_versions || crate::fs::ensure_relative(rel).is_err() {
        return;
    }
    if fill_only && shadow.has_base(rel) {
        return;
    }
    let abs = root.join(rel);
    let Ok(content) = fs::read_to_string(&abs) else {
        return;
    };
    if crate::fs::own_writes::is_own(root, rel, content.as_bytes()) {
        return;
    }
    if let Err(err) = shadow.record(rel, &content) {
        tracing::warn!(path = rel, ?err, "failed to record shadow base");
    }
}

/// What folding the sides of one note decided.
struct FileResolution {
    final_content: String,
    changed: bool,
    /// Content-hash pairs to record as auto-merged once the write lands.
    merge_pairs: Vec<(String, String)>,
    /// Clear the merge-pair record once the write lands (the loop breaker ran).
    clear_merge_pair: bool,
}

/// Fold the working file and its unresolved versions through the ladder,
/// oldest first. Does not touch the provider's version state, which changes
/// only after the resolved write lands.
fn resolve_file(
    root: &Path,
    rel: &str,
    file_modified_ms: u64,
    versions: Vec<VersionRef>,
    shadow: &ShadowStore,
) -> AppResult<FileResolution> {
    let abs = root.join(rel);
    let original = fs::read_to_string(&abs)
        .map_err(|err| AppError::io(format!("unreadable conflicted note {rel}: {err}")))?;
    let sides = read_sides(rel, &original, file_modified_ms, versions)?;
    let base = shadow.base(rel);
    fold_sides(rel, base.as_deref(), &original, sides, shadow, true)
}

/// Fold the sides through the ladder in `(modified_ms, content)` order. The
/// ladder's ordering rule applies to the *fold sequence* too: a timestamp tie
/// must not fall back to platform listing order, or two devices folding the
/// same sides could interleave them differently and write different bytes
/// forever.
fn fold_sides(
    rel: &str,
    base: Option<&str>,
    on_disk: &str,
    mut sides: Vec<ConflictSide>,
    shadow: &ShadowStore,
    detect_loops: bool,
) -> AppResult<FileResolution> {
    sides.sort_by(|a, b| (a.modified_ms, &a.content).cmp(&(b.modified_ms, &b.content)));
    let mut folded = sides.into_iter();
    let mut current = folded
        .next()
        .ok_or_else(|| AppError::io(format!("no versions to fold for {rel}")))?;

    let mut merge_pairs = Vec::new();
    let mut clear_merge_pair = false;
    for side in folded {
        let current_hash = content_hash(&current.content)?;
        let side_hash = content_hash(&side.content)?;
        let modified_ms = side.modified_ms;
        let merge_loop_detected =
            detect_loops && shadow.is_repeated_merge(rel, &current_hash, &side_hash);
        let input = ConflictInput {
            base,
            sides: (current.clone(), side),
            merge_loop_detected,
        };
        match ladder::resolve(input)? {
            Resolution::AlreadyResolved => {}
            Resolution::Merged { content } => {
                if content != current.content {
                    // A genuinely synthesized merge: remember the pair so a
                    // cross-device re-conflict of two merge results is
                    // recognized and broken deterministically.
                    merge_pairs.push((current_hash, side_hash));
                }
                current.content = content;
            }
            Resolution::Reconciled { content } => {
                if merge_loop_detected {
                    clear_merge_pair = true;
                } else if content != current.content {
                    merge_pairs.push((current_hash, side_hash));
                }
                current.content = content;
            }
        }
        current.modified_ms = modified_ms;
    }

    Ok(FileResolution {
        changed: current.content != on_disk,
        final_content: current.content,
        merge_pairs,
        clear_merge_pair,
    })
}

/// Read the working file and the provider's conflict versions as ladder
/// sides. Reads only.
fn read_sides(
    rel: &str,
    original: &str,
    file_modified_ms: u64,
    versions: Vec<VersionRef>,
) -> AppResult<Vec<ConflictSide>> {
    let mut sides = vec![ConflictSide {
        content: original.to_string(),
        modified_ms: file_modified_ms,
    }];
    for version in versions {
        let content = fs::read_to_string(&version.store_path)
            .map_err(|err| AppError::io(format!("unreadable conflict version for {rel}: {err}")))?;
        sides.push(ConflictSide {
            content,
            modified_ms: version.modified_ms,
        });
    }
    Ok(sides)
}

/// Write a resolution to disk, settle the provider's version state when
/// `mark_versions` is set, and do the shadow bookkeeping. Returns `false`
/// when the write failed and nothing else happened.
fn apply_file_resolution(
    root: &Path,
    rel: &str,
    resolution: FileResolution,
    shadow: &ShadowStore,
    mark_versions: bool,
    outcome: &mut SweepOutcome,
) -> bool {
    let abs = root.join(rel);
    if resolution.changed {
        if let Err(err) =
            crate::fs::atomic_write_bytes(root, &abs, resolution.final_content.as_bytes())
        {
            tracing::warn!(path = rel, ?err, "failed to write conflict resolution");
            return false; // versions stay unresolved; next sweep retries
        }
        crate::fs::own_writes::record(root, rel, resolution.final_content.as_bytes());
        outcome.changed.push(SweepChange {
            path: rel.to_string(),
            kind: "upsert".to_string(),
            modified_ms: modified_ms_of(&abs),
        });
    }
    if mark_versions {
        mark_resolved(&abs);
    }
    if resolution.clear_merge_pair {
        shadow.clear_merge_pair(rel);
    }
    for (first, second) in &resolution.merge_pairs {
        let _ = shadow.record_merge_pair(rel, first, second);
    }
    // Both devices converge on the resolved content: it is the new base.
    if let Err(err) = shadow.record(rel, &resolution.final_content) {
        tracing::warn!(path = rel, ?err, "failed to advance shadow base");
    }
    outcome.auto_resolved += 1;
    true
}

/// Write every version of a non-note file that differs from the working file
/// as a conflict copy beside it. A copy that already exists counts as done.
/// Returns `true` when every version is handled, so the caller may mark them
/// resolved; a failure leaves the rest for the next sweep.
fn copy_conflict_versions(
    root: &Path,
    rel: &str,
    versions: Vec<VersionRef>,
    outcome: &mut SweepOutcome,
) -> bool {
    let current_hash = match blob_hash8_of_file(&root.join(rel)) {
        Ok(hash) => hash,
        Err(err) => {
            tracing::warn!(path = rel, ?err, "unreadable conflicted file");
            return false;
        }
    };
    for version in versions {
        let hash8 = match blob_hash8_of_file(&version.store_path) {
            Ok(hash) => hash,
            Err(err) => {
                tracing::warn!(path = rel, ?err, "unreadable conflict version");
                return false;
            }
        };
        if hash8 == current_hash {
            continue;
        }
        let copy_rel = copy_path(rel, version.modified_ms, &hash8);
        let target = root.join(&copy_rel);
        if crate::fs::file_occupied(&target) {
            continue;
        }
        if let Err(err) = write_copy(&version.store_path, &target) {
            tracing::warn!(path = rel, copy = %copy_rel, ?err, "failed to write conflict copy");
            return false;
        }
        outcome.changed.push(SweepChange {
            path: copy_rel.clone(),
            kind: "upsert".to_string(),
            modified_ms: modified_ms_of(&target),
        });
        outcome.copies.push(copy_rel);
    }
    true
}

/// Stream `source` into a temp file beside `target`, then move it into place
/// without overwriting.
fn write_copy(source: &Path, target: &Path) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::io("conflict copy has no parent directory"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    std::io::copy(&mut fs::File::open(source)?, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
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
            continue;
        }
        // Edit conflicts resolve first; the fold retries next sweep.
        let blocked = !no_unresolved_versions(root, &canonical_rel)
            || !no_unresolved_versions(root, &file.path);
        if blocked {
            continue;
        }
        locked(root, || {
            fold_duplicate(root, file, &canonical_rel, shadow, outcome)
        });
    }
}

/// Fold one duplicate into its canonical note: adopt a genuinely free
/// canonical name outright, otherwise merge the pair through the ladder
/// and remove the duplicate. Every early return leaves the duplicate in place for the next
/// sweep to retry. Both files must carry no unresolved provider versions:
/// folding first would advance the canonical's shadow base
/// with content the other device has not seen.
fn fold_duplicate(
    root: &Path,
    file: &crate::fs::FileMeta,
    canonical_rel: &str,
    shadow: &ShadowStore,
    outcome: &mut SweepOutcome,
) {
    let dup_abs = root.join(&file.path);
    let canonical_abs = root.join(canonical_rel);
    let Ok(dup_content) = fs::read_to_string(&dup_abs) else {
        return;
    };
    if !crate::fs::file_occupied(&canonical_abs) {
        // The canonical name is genuinely free (the winner was
        // deleted/renamed — and not merely evicted, which `file_occupied`
        // sees through): the duplicate simply takes its place.
        if fs::rename(&dup_abs, &canonical_abs).is_err() {
            return;
        }
        // Any lingering base under the canonical path belongs to the *old*
        // note that used to live there — the adopted duplicate is an
        // independent creation, and merging against a dead lineage's
        // ancestor would poison a later diff3. Drop it deliberately.
        shadow.forget(canonical_rel);
        // Then record the adopted content as the canonical's base, exactly
        // as the occupied-path fold records its merged result. Peers record
        // one when the rename syncs over (external ingest), but this
        // device's own sweep writes echo back as own-writes — without the
        // record here it alone would stay baseless, and a later concurrent
        // edit would diff3 on one device and not on the other.
        if let Err(err) = shadow.record(canonical_rel, &dup_content) {
            tracing::warn!(path = %canonical_rel, ?err, "failed to record adopted collision base");
        }
        outcome.changed.push(remove_change(&file.path));
        outcome.changed.push(SweepChange {
            path: canonical_rel.to_string(),
            kind: "upsert".to_string(),
            modified_ms: modified_ms_of(&canonical_abs),
        });
        return;
    }
    let Ok(canonical_content) = fs::read_to_string(&canonical_abs) else {
        return; // occupied but unreadable (evicted): retry once downloaded
    };
    let canonical_ms = current_version_modified_ms(&canonical_abs)
        .or_else(|| modified_ms_of(&canonical_abs))
        .unwrap_or(0);
    let dup_ms = current_version_modified_ms(&dup_abs).unwrap_or(file.modified_ms);
    // Version-store dates, not filesystem mtimes, for the same reason as the
    // edit-conflict pass: both devices fold this same pair, and the store's
    // dates are the metadata iCloud actually propagates. Independent
    // creations share no ancestor.
    let sides = vec![
        ConflictSide {
            content: canonical_content.clone(),
            modified_ms: canonical_ms,
        },
        ConflictSide {
            content: dup_content,
            modified_ms: dup_ms,
        },
    ];
    let resolution = match fold_sides(
        canonical_rel,
        None,
        &canonical_content,
        sides,
        shadow,
        false,
    ) {
        Ok(resolution) => resolution,
        Err(err) => {
            tracing::warn!(path = %file.path, ?err, "collision merge failed");
            return;
        }
    };
    if !apply_file_resolution(root, canonical_rel, resolution, shadow, false, outcome) {
        return; // duplicate stays; next sweep retries
    }
    // The canonical rewrite above is real either way, but the duplicate's
    // disappearance must only be reported when it actually happened — a
    // phantom `remove` would drop the index row while the file remains.
    // The merged canonical already contains the duplicate's content, so
    // the retry next sweep is an AlreadyResolved fold + remove.
    if fs::remove_file(&dup_abs).is_ok() {
        outcome.changed.push(remove_change(&file.path));
    } else {
        tracing::warn!(path = %file.path, "failed to remove folded collision duplicate");
    }
}

/// `daily/2026-07-04 2.md` → `Some("daily/2026-07-04.md")`; `None` for
/// anything else. **Daily notes only, with a strict date stem**: their
/// filenames are machine-chosen dates, so a ` <digit>` suffix there can only
/// be iCloud's collision rename (two devices creating the same day offline —
/// the most common conflict shape). Everywhere else the same pattern is
/// indistinguishable from a user-authored title (`notes/chapter 2.md`), and
/// folding one of those would merge two intentional notes — titled notes'
/// same-name collisions simply coexist until the user merges them.
fn collision_canonical(rel: &str) -> Option<String> {
    let stem = rel.strip_prefix("daily/")?.strip_suffix(".md")?;
    let (date, suffix) = stem.rsplit_once(' ')?;
    if !is_daily_date_stem(date) {
        return None;
    }
    let mut digits = suffix.chars();
    let (Some(digit), None) = (digits.next(), digits.next()) else {
        return None;
    };
    if !('2'..='9').contains(&digit) {
        return None;
    }
    Some(format!("daily/{date}.md"))
}

/// Exactly `YYYY-MM-DD` — the shape the app names daily notes with.
fn is_daily_date_stem(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&index| bytes[index].is_ascii_digit())
}

fn remove_change(rel: &str) -> SweepChange {
    SweepChange {
        path: rel.to_string(),
        kind: "remove".to_string(),
        modified_ms: None,
    }
}

fn modified_ms_of(abs: &Path) -> Option<u64> {
    abs.metadata()
        .ok()
        .as_ref()
        .and_then(crate::fs::modified_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            collision_canonical("daily/2026-07-04 9.md"),
            Some("daily/2026-07-04.md".to_string())
        );
        // Titled notes never fold — `notes/chapter 2.md` is indistinguishable
        // from a user-authored title, and merging intentional notes is worse
        // than leaving a real collision pair side by side.
        assert_eq!(collision_canonical("notes/meeting 9.md"), None);
        assert_eq!(collision_canonical("notes/chapter 2.md"), None);
        // Inside daily/, only the strict machine date-stem shape qualifies.
        assert_eq!(collision_canonical("daily/2026-07-04-2.md"), None);
        assert_eq!(collision_canonical("daily/2026-07-04.md"), None);
        assert_eq!(collision_canonical("daily/2026-07-04 10.md"), None);
        assert_eq!(collision_canonical("daily/journal 2.md"), None);
        assert_eq!(collision_canonical("daily/2026-7-04 2.md"), None);
    }

    #[test]
    fn daily_collision_duplicates_union_into_the_canonical_file() {
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "# Day\n\n- from mac\n");
        write(
            root.path(),
            "daily/2026-07-04 2.md",
            "# Day\n\n- from phone\n",
        );
        // A base recorded for the duplicate (an earlier external ingest of
        // it) must not outlive the file the fold removes this same pass.
        ShadowStore::new(root.path())
            .record("daily/2026-07-04 2.md", "# Day\n\n- from phone\n")
            .unwrap();

        let outcome = run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert_eq!(outcome.auto_resolved, 1);
        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# Day\n\n- from mac\n- from phone\n"
        );
        // Changes report the remove + the rewrite for direct reindexing.
        let kinds: Vec<(&str, &str)> = outcome
            .changed
            .iter()
            .map(|change| (change.path.as_str(), change.kind.as_str()))
            .collect();
        assert!(kinds.contains(&("daily/2026-07-04 2.md", "remove")));
        assert!(kinds.contains(&("daily/2026-07-04.md", "upsert")));
        // The base the fold just recorded survives the same pass's orphan
        // pruning (the keep-set includes this sweep's own upserts) — while
        // the removed duplicate's base is pruned in the same pass, not left
        // to linger until the next sweep's listing misses it.
        let shadow = ShadowStore::new(root.path());
        assert_eq!(
            shadow.base("daily/2026-07-04.md"),
            Some("# Day\n\n- from mac\n- from phone\n".to_string())
        );
        assert_eq!(shadow.base("daily/2026-07-04 2.md"), None);
    }

    #[test]
    fn a_collision_fold_ignores_a_recorded_merge_pair() {
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "# Day\n\n- from mac\n");
        write(
            root.path(),
            "daily/2026-07-04 2.md",
            "# Day\n\n- from phone\n",
        );
        ShadowStore::new(root.path())
            .record_merge_pair(
                "daily/2026-07-04.md",
                &content_hash("# Day\n\n- from mac\n").unwrap(),
                &content_hash("# Day\n\n- from phone\n").unwrap(),
            )
            .unwrap();

        run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# Day\n\n- from mac\n- from phone\n"
        );
    }

    #[test]
    fn an_orphaned_duplicate_takes_the_free_canonical_name() {
        let root = graph();
        write(root.path(), "daily/2026-07-04 2.md", "- phone only\n");
        // A base lingering from the canonical path's previous life belongs to
        // a dead lineage — adopting the duplicate must drop it, or a later
        // diff3 would merge against the wrong ancestor.
        let shadow = ShadowStore::new(root.path());
        shadow
            .record("daily/2026-07-04.md", "- old lineage\n")
            .unwrap();

        run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert!(root.path().join("daily/2026-07-04.md").exists());
        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        // The dead lineage's ancestor is gone — the adopted content is the
        // base now, matching what peers record when the rename syncs over.
        assert_eq!(
            shadow.base("daily/2026-07-04.md"),
            Some("- phone only\n".to_string())
        );
    }

    #[test]
    fn an_evicted_canonical_is_not_a_free_slot() {
        // The canonical note exists only as an iCloud eviction stub: the
        // duplicate must wait (folding retries once the content downloads),
        // never rename itself onto the reserved name.
        let root = graph();
        write(root.path(), "daily/.2026-07-04.md.icloud", "stub");
        write(root.path(), "daily/2026-07-04 2.md", "- phone only\n");

        let outcome = run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert!(!root.path().join("daily/2026-07-04.md").exists());
        assert!(root.path().join("daily/2026-07-04 2.md").exists());
        assert!(root.path().join("daily/.2026-07-04.md.icloud").exists());
        assert!(outcome.changed.is_empty());
    }

    #[test]
    fn overlapping_collision_bodies_reconcile_into_the_canonical() {
        let root = graph();
        // The tails overlap ("- common tail" follows both divergent lines) —
        // the union guard refuses, so the word-level merge keeps both
        // wordings.
        write(
            root.path(),
            "daily/2026-07-04.md",
            "- shared\n- mac wording\n- common tail\n",
        );
        write(
            root.path(),
            "daily/2026-07-04 2.md",
            "- shared\n- phone wording\n- common tail\n",
        );

        let outcome = run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert_eq!(outcome.auto_resolved, 1);
        let merged = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert!(merged.contains("mac wording") && merged.contains("phone wording"));
        assert!(merged.contains("common tail"));
    }

    #[test]
    fn titled_note_number_suffixes_are_left_alone() {
        // "chapter.md" and "chapter 2.md" are two intentional notes, not an
        // iCloud collision — the sweep must not merge or rename them.
        let root = graph();
        write(root.path(), "notes/chapter.md", "# Chapter\n");
        write(root.path(), "notes/chapter 2.md", "# Chapter 2\n");

        let outcome = run_sweep(root.path(), &[], &[], false, None).unwrap();

        assert!(outcome.changed.is_empty());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/chapter 2.md")).unwrap(),
            "# Chapter 2\n"
        );
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
            None,
        )
        .unwrap();

        assert!(outcome.changed.is_empty());
        assert!(root.path().join("daily/2026-07-04 2.md").exists());
    }

    #[test]
    fn scoped_sweeps_defer_housekeeping_to_the_next_full_sweep() {
        let root = graph();
        write(root.path(), "notes/a.md", "# a\n");
        // Record a base, then delete the note externally — an orphaned base.
        run_sweep(root.path(), &[], &["notes/a.md".to_string()], false, None).unwrap();
        assert!(ShadowStore::new(root.path()).base("notes/a.md").is_some());
        fs::remove_file(root.path().join("notes/a.md")).unwrap();

        // A candidate-scoped sweep leaves the orphan alone (pruning against
        // its narrower view would be wrong; deferring it is safe)…
        run_sweep(root.path(), &[], &[], false, Some(HashSet::new())).unwrap();
        assert!(ShadowStore::new(root.path()).base("notes/a.md").is_some());

        // …and the next full sweep prunes it.
        run_sweep(root.path(), &[], &[], false, None).unwrap();
        assert!(ShadowStore::new(root.path()).base("notes/a.md").is_none());
    }

    #[test]
    fn ingested_scope_checks_exactly_the_arrivals_and_full_checks_everything() {
        let arrivals = vec!["notes/a.md".to_string(), "daily/2026-07-04.md".to_string()];
        assert_eq!(
            super::conflict_candidates(SweepScope::Ingested, &arrivals),
            Some(arrivals.iter().cloned().collect::<HashSet<_>>())
        );
        assert_eq!(
            super::conflict_candidates(SweepScope::Full, &arrivals),
            None
        );
        // No metadata watch is installed in a test process (nor ever on
        // desktop): the candidate scope must degrade to a full check, never
        // to an empty one.
        assert_eq!(
            super::conflict_candidates(SweepScope::Candidates, &arrivals),
            None
        );
    }

    #[test]
    fn scoped_sweeps_still_fold_collision_duplicates() {
        // The scope narrows only the NSFileVersion checks — collision
        // folding works from the listing and must not be skipped, or a
        // bulk-sync's "2026-07-04 2.md" would sit unfolded until resume.
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "- a\n");
        write(root.path(), "daily/2026-07-04 2.md", "- b\n");

        run_sweep(root.path(), &[], &[], false, Some(HashSet::new())).unwrap();

        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
    }

    #[test]
    fn dirty_paths_never_advance_the_base() {
        // A dirty open session may overwrite the file with pre-external
        // content; recording the external revision as the base would turn
        // that overwrite into a phantom deletion in a later three-way merge.
        let root = graph();
        write(root.path(), "notes/open.md", "# external revision\n");

        run_sweep(
            root.path(),
            &["notes/open.md".to_string()],
            &["notes/open.md".to_string()],
            true, // even an adoption baseline must respect the dirty skip
            None,
        )
        .unwrap();

        assert_eq!(ShadowStore::new(root.path()).base("notes/open.md"), None);
    }

    #[test]
    fn traversal_shaped_ingest_paths_are_refused() {
        let root = graph();
        // A file *outside* the graph that a traversal shape would reach.
        let parent = root.path().parent().unwrap();
        fs::write(parent.join("evil.md"), "outside\n").unwrap();

        run_sweep(
            root.path(),
            &[],
            &["../evil.md".to_string(), "/etc/hosts".to_string()],
            false,
            None,
        )
        .unwrap();

        // Nothing was recorded anywhere in the store.
        assert!(!root.path().join(".reflect/sync-base").exists());
    }

    #[test]
    fn baseline_and_ingest_record_shadow_bases() {
        let root = graph();
        write(root.path(), "notes/a.md", "# A\n");
        write(root.path(), "notes/b.md", "# B\n");

        run_sweep(root.path(), &[], &[], true, None).unwrap();
        let shadow = ShadowStore::new(root.path());
        assert_eq!(shadow.base("notes/a.md"), Some("# A\n".to_string()));

        write(root.path(), "notes/b.md", "# B updated externally\n");
        run_sweep(root.path(), &[], &["notes/b.md".to_string()], false, None).unwrap();
        assert_eq!(
            shadow.base("notes/b.md"),
            Some("# B updated externally\n".to_string())
        );
    }

    #[test]
    fn own_writes_are_not_a_shadow_base() {
        let root = graph();
        let rel = "notes/own-write-base.md";
        write(root.path(), rel, "# Written here\n");
        crate::fs::own_writes::record(root.path(), rel, b"# Written here\n");
        run_sweep(root.path(), &[], &[rel.to_string()], true, None).unwrap();
        let shadow = ShadowStore::new(root.path());
        assert_eq!(shadow.base(rel), None);

        write(root.path(), rel, "# Arrived from elsewhere\n");
        run_sweep(root.path(), &[], &[rel.to_string()], false, None).unwrap();
        assert_eq!(
            shadow.base(rel),
            Some("# Arrived from elsewhere\n".to_string())
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
            }],
            &shadow,
        )
        .unwrap();

        assert!(resolution.changed);
        // Union order is by version timestamp: the phone side (1000) is older
        // than the file (2000), so its line lands first.
        assert_eq!(
            resolution.final_content,
            "- seed\n- phone line\n- mac line\n"
        );
    }

    #[test]
    fn resolve_file_reconciles_overlapping_edits_without_markers() {
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
            }],
            &shadow,
        )
        .unwrap();

        assert!(resolution.final_content.contains("mac"));
        assert!(resolution.final_content.contains("phone"));
    }

    fn fake_version(root: &Path, name: &str, content: &str, modified_ms: u64) -> VersionRef {
        let store = root.join(".reflect").join(name);
        fs::write(&store, content).unwrap();
        VersionRef {
            store_path: store,
            modified_ms,
        }
    }

    #[test]
    fn multi_version_clean_folds_keep_every_side() {
        // Three devices appended apart: both fold steps stay clean, all
        // three tails land, and none is lost.
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "- seed\n- mac line\n");
        let shadow = ShadowStore::new(root.path());
        shadow.record("daily/2026-07-04.md", "- seed\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "daily/2026-07-04.md",
            3_000,
            vec![
                fake_version(root.path(), "v-phone.md", "- seed\n- phone line\n", 1_000),
                fake_version(root.path(), "v-ipad.md", "- seed\n- ipad line\n", 2_000),
            ],
            &shadow,
        )
        .unwrap();

        for line in ["- mac line", "- phone line", "- ipad line"] {
            assert!(
                resolution.final_content.contains(line),
                "lost {line} in: {}",
                resolution.final_content
            );
        }
    }

    #[test]
    fn multi_version_overlap_keeps_every_side_as_substrings() {
        // Overlapping edits across three devices fold pairwise through the
        // ladder; every side's words stay in the note.
        let root = graph();
        write(root.path(), "notes/a.md", "wording from mac\n");
        let shadow = ShadowStore::new(root.path());
        shadow.record("notes/a.md", "original wording\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "notes/a.md",
            3_000,
            vec![
                fake_version(root.path(), "v1.md", "wording from phone\n", 1_000),
                fake_version(root.path(), "v2.md", "wording from ipad\n", 2_000),
            ],
            &shadow,
        )
        .unwrap();

        for wording in ["mac", "phone", "ipad"] {
            assert!(
                resolution.final_content.contains(wording),
                "lost {wording} in: {}",
                resolution.final_content
            );
        }
    }

    #[test]
    fn multi_version_folds_are_order_independent_even_on_timestamp_ties() {
        // Two conflict versions sharing one modification time: whichever
        // order the platform lists them in, the fold must emit identical
        // bytes — the tiebreak is content, exactly like the ladder's rule.
        fn run(root: &Path, first: &str, second: &str) -> String {
            fs::write(root.join("daily/2026-07-04.md"), "- seed\n- mac\n").unwrap();
            let shadow = ShadowStore::new(root);
            shadow.record("daily/2026-07-04.md", "- seed\n").unwrap();
            let versions = vec![
                fake_version(root, "va.md", first, 1_000),
                fake_version(root, "vb.md", second, 1_000),
            ];
            resolve_file(root, "daily/2026-07-04.md", 2_000, versions, &shadow)
                .unwrap()
                .final_content
        }

        let one_root = graph();
        let one = run(one_root.path(), "- seed\n- phone\n", "- seed\n- pad\n");
        let two_root = graph();
        let two = run(two_root.path(), "- seed\n- pad\n", "- seed\n- phone\n");
        assert_eq!(one, two);
    }

    #[test]
    fn a_word_level_merge_records_the_pair_so_a_repeat_breaks_the_loop() {
        let root = graph();
        write(root.path(), "notes/a.md", "shared line mac\n");
        let shadow = ShadowStore::new(root.path());
        shadow.record("notes/a.md", "shared line\n").unwrap();
        let mac_hash = content_hash("shared line mac\n").unwrap();
        let phone_hash = content_hash("shared line phone\n").unwrap();

        let version = fake_version(root.path(), "v1.md", "shared line phone\n", 2_000);
        let first = resolve_file(root.path(), "notes/a.md", 1_000, vec![version], &shadow).unwrap();
        // Nothing is recorded until the write lands.
        assert!(!shadow.is_repeated_merge("notes/a.md", &mac_hash, &phone_hash));
        let mut outcome = SweepOutcome::default();
        apply_file_resolution(
            root.path(),
            "notes/a.md",
            first,
            &shadow,
            true,
            &mut outcome,
        );
        assert!(shadow.is_repeated_merge("notes/a.md", &mac_hash, &phone_hash));
        // The other device's merge result is replaced by the same two sides.
        write(root.path(), "notes/a.md", "shared line mac\n");
        assert!(shadow.is_repeated_merge("notes/a.md", &mac_hash, &phone_hash));

        let version = fake_version(root.path(), "v2.md", "shared line phone\n", 2_000);
        let second =
            resolve_file(root.path(), "notes/a.md", 1_000, vec![version], &shadow).unwrap();
        assert_eq!(second.final_content, "shared line phone\n");
        apply_file_resolution(
            root.path(),
            "notes/a.md",
            second,
            &shadow,
            true,
            &mut outcome,
        );
        assert!(!shadow.is_repeated_merge("notes/a.md", &mac_hash, &phone_hash));
    }

    const VERSION_MS: u64 = 1_792_119_845_000;

    fn version(root: &Path, name: &str, bytes: &[u8], modified_ms: u64) -> VersionRef {
        let store_path = root.join(".reflect").join(name);
        fs::write(&store_path, bytes).unwrap();
        VersionRef {
            store_path,
            modified_ms,
        }
    }

    fn json_graph() -> tempfile::TempDir {
        let root = graph();
        fs::create_dir_all(root.path().join("assets")).unwrap();
        write(root.path(), "assets/data.json", "{\"a\":1}");
        root
    }

    #[test]
    fn a_json_conflict_version_becomes_a_sibling_copy() {
        let root = json_graph();
        let v = version(root.path(), "v1", b"{\"a\":2}", VERSION_MS);
        let hash8 = blob_hash8_of_file(&v.store_path).unwrap();
        let mut outcome = SweepOutcome::default();

        assert!(copy_conflict_versions(
            root.path(),
            "assets/data.json",
            vec![v],
            &mut outcome
        ));

        let copy = format!("assets/data (conflict 2026-10-16 03-04-05 {hash8}).json");
        assert_eq!(fs::read(root.path().join(&copy)).unwrap(), b"{\"a\":2}");
        assert_eq!(outcome.copies, vec![copy.clone()]);
        assert!(outcome
            .changed
            .iter()
            .any(|change| change.path == copy && change.kind == "upsert"));
        assert_eq!(
            fs::read_to_string(root.path().join("assets/data.json")).unwrap(),
            "{\"a\":1}"
        );
    }

    #[test]
    fn a_binary_conflict_version_is_marked_resolved_after_the_copy() {
        let root = graph();
        write(root.path(), "notes/clip.bin", "x");
        fs::write(root.path().join("notes/clip.bin"), [0u8, 1, 2]).unwrap();
        let first = version(root.path(), "v1", &[0u8, 9, 9], VERSION_MS);
        let missing = VersionRef {
            store_path: root.path().join(".reflect/missing"),
            modified_ms: VERSION_MS + 1000,
        };
        let mut outcome = SweepOutcome::default();

        let done = copy_conflict_versions(
            root.path(),
            "notes/clip.bin",
            vec![first, missing],
            &mut outcome,
        );

        assert!(!done);
        assert_eq!(outcome.copies.len(), 1);
        assert_eq!(
            fs::read(root.path().join(&outcome.copies[0])).unwrap(),
            [0u8, 9, 9]
        );

        let ok = version(root.path(), "v2", &[0u8, 9, 9], VERSION_MS);
        let mut again = SweepOutcome::default();
        assert!(copy_conflict_versions(
            root.path(),
            "notes/clip.bin",
            vec![ok],
            &mut again
        ));
        assert!(again.copies.is_empty());
    }

    #[test]
    fn two_devices_name_the_same_icloud_copy() {
        let names: Vec<String> = (0..2)
            .map(|_| {
                let root = json_graph();
                let v = version(root.path(), "v1", b"{\"a\":2}", VERSION_MS);
                let mut outcome = SweepOutcome::default();
                copy_conflict_versions(root.path(), "assets/data.json", vec![v], &mut outcome);
                outcome.copies[0].clone()
            })
            .collect();
        assert_eq!(names[0], names[1]);
    }

    #[test]
    fn a_version_equal_to_the_current_file_writes_no_copy() {
        let root = json_graph();
        let v = version(root.path(), "v1", b"{\"a\":1}", VERSION_MS);
        let mut outcome = SweepOutcome::default();

        assert!(copy_conflict_versions(
            root.path(),
            "assets/data.json",
            vec![v],
            &mut outcome
        ));

        assert!(outcome.copies.is_empty());
        assert!(outcome.changed.is_empty());
    }

    #[test]
    fn a_repeated_sweep_keeps_one_copy() {
        let root = json_graph();
        let mut total = 0;
        for _ in 0..2 {
            let v = version(root.path(), "v1", b"{\"a\":2}", VERSION_MS);
            let mut outcome = SweepOutcome::default();
            assert!(copy_conflict_versions(
                root.path(),
                "assets/data.json",
                vec![v],
                &mut outcome
            ));
            total += outcome.copies.len();
        }
        assert_eq!(total, 1);
        let count = fs::read_dir(root.path().join("assets")).unwrap().count();
        assert_eq!(count, 2);
    }

    #[test]
    fn the_sweep_checks_attachments_not_only_notes() {
        let root = json_graph();
        write(root.path(), "notes/a.md", "# A\n");
        let (notes, attachments) = crate::fs::note_and_attachment_files(root.path());
        let paths = |files: &[crate::fs::FileMeta]| -> Vec<String> {
            files.iter().map(|file| file.path.clone()).collect()
        };
        assert_eq!(paths(&notes), vec!["notes/a.md"]);
        assert_eq!(paths(&attachments), vec!["assets/data.json"]);
    }
}
