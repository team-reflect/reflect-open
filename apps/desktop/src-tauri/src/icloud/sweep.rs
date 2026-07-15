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
use crate::conflict::{archive, markers, ConflictSide, Resolution};
use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

use super::versions::{
    current_version_modified_ms, mark_resolved, unresolved_versions, VersionRef,
};

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
    let sweep_root = root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_sweep(&sweep_root, &skip_paths, &ingested_paths, record_baseline)
    })
    .await
    .map_err(|err| AppError::io(err.to_string()))??;
    crate::fs::invalidate_file_catalog(&state, &root);
    Ok(outcome)
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
        // A dirty open session may still overwrite this file with content
        // derived from an *older* state — advancing the base to the external
        // revision now would make a later diff3 read that overwrite as "we
        // deleted the other device's lines" and drop them. Stale is the safe
        // direction; the base advances once the session settles.
        if skip.contains(rel.as_str()) {
            continue;
        }
        advance_base_if_clean(root, rel, &shadow, false);
    }

    let files = crate::fs::note_files(root)?;

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
                advance_base_if_clean(root, &file.path, &shadow, true);
            }
        }
    }

    fold_collision_duplicates(root, &files, &shadow, &skip, &mut outcome);

    for file in &files {
        if file.placeholder {
            continue;
        }
        let abs = root.join(&file.path);
        let scan = unresolved_versions(&abs);
        if scan.none() {
            continue;
        }
        if !scan.complete {
            // A version with no readable store path can't be archived, and
            // mark_resolved would purge it — defer the whole file instead.
            outcome.deferred.push(file.path.clone());
            continue;
        }
        if skip.contains(file.path.as_str()) {
            outcome.deferred.push(file.path.clone());
            continue;
        }
        // Order the working copy by the version store's date for it — the
        // metadata the *other* device sees for this same content as a
        // conflict version — never the filesystem mtime, which iCloud does
        // not propagate bit-exactly. Mixed keys would let two devices order
        // the same content pair differently and emit different merged bytes.
        let current_ms = current_version_modified_ms(&abs).unwrap_or(file.modified_ms);
        match resolve_file(root, &file.path, current_ms, scan.versions, &shadow) {
            Ok(resolved) => {
                apply_file_resolution(root, &file.path, resolved, &shadow, &mut outcome)
            }
            Err(err) => {
                // One bad note must not stop the sweep; versions stay
                // unresolved and the next sweep retries it.
                tracing::warn!(path = %file.path, ?err, "conflict resolution failed");
            }
        }
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
    shadow.prune_orphans(&live);

    archive::prune(root);
    Ok(outcome)
}

/// A clean external ingest (or adoption snapshot): the note's disk content is
/// now what both sides derive from — record it as the base. Skips notes that
/// currently carry unresolved versions (mid-conflict content is nobody's
/// ancestor), notes whose content carries conflict markers (a marked file is
/// an unresolved review state, never a synced ancestor — and the sweep's own
/// marker writes echo back through the file watcher as ordinary external
/// upserts, so the guard must live here, not in the caller), and
/// non-UTF-8/missing files. `fill_only` restricts the write to notes without
/// a base (the adoption case).
fn advance_base_if_clean(root: &Path, rel: &str, shadow: &ShadowStore, fill_only: bool) {
    // `ingested_paths` arrive over IPC — refuse traversal shapes before any
    // filesystem access, like every other IPC-supplied graph path. (The
    // shadow store would reject the *write*, but the read must not happen
    // either.)
    if crate::fs::ensure_relative(rel).is_err() {
        return;
    }
    if fill_only && shadow.base(rel).is_some() {
        return;
    }
    let abs = root.join(rel);
    if !unresolved_versions(&abs).none() {
        return;
    }
    let Ok(content) = fs::read_to_string(&abs) else {
        return;
    };
    if markers::contains_conflict_markers(&content) {
        return;
    }
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
/// Archives every side before anything else ([`archived_sides`]). Does not
/// touch the provider's version state — the caller does, after the resolved
/// write lands.
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
    let sides = archived_sides(root, rel, &original, file_modified_ms, versions)?;

    let base = shadow.base(rel);
    let mut current = ConflictSide {
        content: original.clone(),
        label: LOCAL_LABEL.to_string(),
        modified_ms: file_modified_ms,
    };

    // With MULTIPLE versions, the pairwise loop below is unsound: an
    // intermediate step's marker output would meet the ladder's marked-side
    // rule on the next step, which keeps the newest raw side whole — the
    // earlier versions' content would survive only in the archive, not the
    // note. Multi-version folds therefore auto-merge only while every step
    // stays clean, and the first overlap abandons the fold for one flat
    // marker file carrying every side.
    if sides.len() >= 2 {
        return resolve_many(rel, base.as_deref(), current, sides, shadow, &original);
    }

    let mut marked = false;
    for side in sides {
        let current_hash = content_hash(&current.content)?;
        let side_hash = content_hash(&side.content)?;
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

/// The three-plus-way fold (two or more conflict versions — three or more
/// devices edited apart). Auto-merges pairwise only while every step stays
/// clean; any overlap yields **flat stacked markers over every side**
/// ([`markers::stacked_whole_note_markers`]) so no resolution choice can
/// lose a side. A side that already carries markers can't be stacked
/// (nesting corrupts the grammar) — the two-way marked-side rule extends to
/// n sides: the deterministically newest survives whole, the rest stay in
/// the archive.
fn resolve_many(
    rel: &str,
    base: Option<&str>,
    current: ConflictSide,
    sides: Vec<ConflictSide>,
    shadow: &ShadowStore,
    original: &str,
) -> AppResult<FileResolution> {
    let all = || std::iter::once(&current).chain(sides.iter());
    if all().any(|side| markers::contains_conflict_markers(&side.content)) {
        let newest = all()
            .max_by(|a, b| (a.modified_ms, &a.content).cmp(&(b.modified_ms, &b.content)))
            .expect("the current side always exists");
        return Ok(FileResolution {
            changed: newest.content != original,
            marked: markers::contains_conflict_markers(&newest.content),
            final_content: newest.content.clone(),
        });
    }

    let mut folded = current.clone();
    let mut clean = true;
    for side in &sides {
        let folded_hash = content_hash(&folded.content)?;
        let side_hash = content_hash(&side.content)?;
        let input = ConflictInput {
            path: rel,
            base,
            sides: (folded.clone(), side.clone()),
            creation_collision: false,
            merge_loop_detected: shadow.is_repeated_merge(rel, &folded_hash, &side_hash),
        };
        match ladder::resolve(input)? {
            Resolution::AlreadyResolved => {}
            Resolution::Merged { content } => {
                if content != folded.content {
                    let _ = shadow.record_merge_pair(rel, &folded_hash, &side_hash);
                }
                folded.content = content;
            }
            Resolution::Marked { .. } => {
                clean = false;
                break;
            }
        }
    }
    if clean {
        return Ok(FileResolution {
            changed: folded.content != original,
            final_content: folded.content,
            marked: false,
        });
    }

    let mut ordered: Vec<ConflictSide> = std::iter::once(current).chain(sides).collect();
    ordered.sort_by(|a, b| (a.modified_ms, &a.content).cmp(&(b.modified_ms, &b.content)));
    let content = markers::stacked_whole_note_markers(&ordered);
    Ok(FileResolution {
        changed: content != original,
        final_content: content,
        marked: true,
    })
}

/// Read and archive **every** involved version — the current file, then the
/// provider's conflict versions — and return the version sides sorted oldest
/// first, ready for the ladder. The archive-before-anything invariant lives
/// here: a resolution must never become the only copy-holder of content it
/// consumed.
fn archived_sides(
    root: &Path,
    rel: &str,
    original: &str,
    file_modified_ms: u64,
    versions: Vec<VersionRef>,
) -> AppResult<Vec<ConflictSide>> {
    archive::archive_version(root, rel, None, file_modified_ms, original.as_bytes())?;
    let mut sides: Vec<ConflictSide> = Vec::new();
    for version in &versions {
        let content = fs::read_to_string(&version.store_path)
            .map_err(|err| AppError::io(format!("unreadable conflict version for {rel}: {err}")))?;
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
    // The ladder's ordering rule, applied to the *fold sequence* too: a
    // timestamp tie must not fall back to platform listing order, or two
    // devices folding the same versions could interleave them differently
    // and write different bytes forever. Contents are read above, so the
    // tiebreak has something to compare.
    sides.sort_by(|a, b| (a.modified_ms, &a.content).cmp(&(b.modified_ms, &b.content)));
    Ok(sides)
}

/// Write a resolution to disk, settle the provider's version state, and do
/// the shadow bookkeeping.
fn apply_file_resolution(
    root: &Path,
    rel: &str,
    resolution: FileResolution,
    shadow: &ShadowStore,
    outcome: &mut SweepOutcome,
) {
    let abs = root.join(rel);
    if resolution.changed {
        if let Err(err) =
            crate::fs::atomic_write_bytes(root, &abs, resolution.final_content.as_bytes())
        {
            tracing::warn!(path = rel, ?err, "failed to write conflict resolution");
            return; // versions stay unresolved; next sweep retries
        }
    }
    if resolution.changed || resolution.marked {
        // Marked-but-unchanged is defensive (the ladder's marker rules make
        // it near-unreachable today): if it ever happens, the controller
        // must still reindex so `has_conflict` and the notice reflect the
        // markers — content-hash gating makes a redundant reindex free.
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
        fold_duplicate(root, file, &canonical_rel, shadow, outcome);
    }
}

/// Fold one duplicate into its canonical note: adopt a genuinely free
/// canonical name outright, otherwise archive the duplicate, merge the pair
/// through the ladder, and remove the duplicate. Every early return leaves
/// the duplicate in place for the next sweep to retry.
fn fold_duplicate(
    root: &Path,
    file: &crate::fs::FileMeta,
    canonical_rel: &str,
    shadow: &ShadowStore,
    outcome: &mut SweepOutcome,
) {
    let dup_abs = root.join(&file.path);
    let canonical_abs = root.join(canonical_rel);
    // Both conflict shapes can coincide: the canonical (or the duplicate)
    // may carry unresolved NSFileVersion conflicts at the same time as the
    // name collision. Folding first would rewrite the canonical and advance
    // its shadow base *before* the version pass archives anything — breaking
    // archive-first, and poisoning the base with content the other device
    // hasn't seen. Edit conflicts resolve first; the fold retries next sweep.
    if !unresolved_versions(&canonical_abs).none() || !unresolved_versions(&dup_abs).none() {
        outcome.deferred.push(file.path.clone());
        return;
    }
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
        // edit would diff3 on one device and fall to markers on the other.
        // Marker content stays unrecorded on every device alike.
        if !markers::contains_conflict_markers(&dup_content) {
            if let Err(err) = shadow.record(canonical_rel, &dup_content) {
                tracing::warn!(path = %canonical_rel, ?err, "failed to record adopted collision base");
            }
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
    if let Err(err) = archive::archive_version(
        root,
        &file.path,
        None,
        file.modified_ms,
        dup_content.as_bytes(),
    ) {
        tracing::warn!(path = %file.path, ?err, "failed to archive collision duplicate");
        return;
    }
    let input = ConflictInput {
        path: canonical_rel,
        base: None, // independent creations share no ancestor
        // Version-store dates, not filesystem mtimes, for the same reason as
        // the edit-conflict pass: both devices fold this same pair, and the
        // store's dates are the metadata iCloud actually propagates.
        sides: (
            ConflictSide {
                content: canonical_content.clone(),
                label: canonical_rel.to_string(),
                modified_ms: current_version_modified_ms(&canonical_abs)
                    .or_else(|| modified_ms_of(&canonical_abs))
                    .unwrap_or(0),
            },
            ConflictSide {
                content: dup_content,
                label: file.path.clone(),
                modified_ms: current_version_modified_ms(&dup_abs).unwrap_or(file.modified_ms),
            },
        ),
        creation_collision: true,
        merge_loop_detected: false,
    };
    let resolution = match ladder::resolve(input) {
        Ok(resolution) => resolution,
        Err(err) => {
            tracing::warn!(path = %file.path, ?err, "collision merge failed");
            return;
        }
    };
    let (merged, is_marked) = match resolution {
        Resolution::AlreadyResolved => (canonical_content.clone(), false),
        Resolution::Merged { content } => (content, false),
        Resolution::Marked { content } => (content, true),
    };
    if merged != canonical_content {
        if crate::fs::atomic_write_bytes(root, &canonical_abs, merged.as_bytes()).is_err() {
            return; // duplicate stays; next sweep retries
        }
        outcome.changed.push(SweepChange {
            path: canonical_rel.to_string(),
            kind: "upsert".to_string(),
            modified_ms: modified_ms_of(&canonical_abs),
        });
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
    if is_marked {
        outcome.needs_review.push(canonical_rel.to_string());
        shadow.clear_merge_pair(canonical_rel);
    } else {
        outcome.auto_resolved += 1;
        if let Err(err) = shadow.record(canonical_rel, &merged) {
            tracing::warn!(path = %canonical_rel, ?err, "failed to advance shadow base");
        }
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

/// A real `YYYY-MM-DD` calendar date — impossible date-shaped filenames are
/// ordinary adopted notes and must never enter the destructive collision fold.
fn is_daily_date_stem(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || ![0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&index| bytes[index].is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = stem[..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = stem[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = stem[8..].parse::<u32>() else {
        return false;
    };
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
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
        assert_eq!(collision_canonical("daily/2026-02-31 2.md"), None);
        assert_eq!(collision_canonical("daily/2025-02-29 2.md"), None);
        assert_eq!(
            collision_canonical("daily/2024-02-29 2.md"),
            Some("daily/2024-02-29.md".to_string())
        );
    }

    #[test]
    fn impossible_date_collision_names_are_preserved_as_adopted_notes() {
        let root = graph();
        write(
            root.path(),
            "daily/2026-02-31 2.md",
            "intentional adopted note\n",
        );

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert!(outcome.changed.is_empty());
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-02-31 2.md")).unwrap(),
            "intentional adopted note\n"
        );
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

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert!(root.path().join("daily/2026-07-04.md").exists());
        assert!(!root.path().join("daily/2026-07-04 2.md").exists());
        assert_eq!(outcome.needs_review.len(), 0);
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

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert!(!root.path().join("daily/2026-07-04.md").exists());
        assert!(root.path().join("daily/2026-07-04 2.md").exists());
        assert!(root.path().join("daily/.2026-07-04.md.icloud").exists());
        assert!(outcome.changed.is_empty());
    }

    #[test]
    fn overlapping_collision_bodies_mark_the_canonical_for_review() {
        let root = graph();
        // The tails overlap ("- common tail" follows both divergent lines) —
        // the union guard refuses, so the canonical file ends up marked, and
        // the labels are the two filenames the content came from.
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

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

        assert_eq!(
            outcome.needs_review,
            vec!["daily/2026-07-04.md".to_string()]
        );
        let merged = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert!(markers::contains_conflict_markers(&merged));
        assert!(merged.contains("daily/2026-07-04.md") && merged.contains("daily/2026-07-04 2.md"));
    }

    #[test]
    fn titled_note_number_suffixes_are_left_alone() {
        // "chapter.md" and "chapter 2.md" are two intentional notes, not an
        // iCloud collision — the sweep must not merge or rename them.
        let root = graph();
        write(root.path(), "notes/chapter.md", "# Chapter\n");
        write(root.path(), "notes/chapter 2.md", "# Chapter 2\n");

        let outcome = run_sweep(root.path(), &[], &[], false).unwrap();

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
        )
        .unwrap();

        assert_eq!(outcome.deferred, vec!["daily/2026-07-04 2.md".to_string()]);
        assert!(root.path().join("daily/2026-07-04 2.md").exists());
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
        )
        .unwrap();

        // Nothing was recorded anywhere in the store.
        assert!(!root.path().join(".reflect/sync-base").exists());
    }

    #[test]
    fn marker_carrying_content_never_becomes_a_base() {
        // The sweep's own marker writes echo back through the file watcher
        // as ordinary external upserts — an unresolved review state must
        // never be recorded as a synced ancestor.
        let root = graph();
        write(
            root.path(),
            "notes/a.md",
            "<<<<<<< Mac\nmine\n=======\ntheirs\n>>>>>>> iPhone\n",
        );

        run_sweep(root.path(), &[], &["notes/a.md".to_string()], true).unwrap();

        assert_eq!(ShadowStore::new(root.path()).base("notes/a.md"), None);
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
        assert!(markers::contains_conflict_markers(
            &resolution.final_content
        ));
        assert!(resolution.final_content.contains("Alex's iPhone"));
        assert!(resolution.final_content.contains(LOCAL_LABEL));
    }

    fn fake_version(
        root: &Path,
        name: &str,
        content: &str,
        modified_ms: u64,
        device: &str,
    ) -> VersionRef {
        let store = root.join(".reflect").join(name);
        fs::write(&store, content).unwrap();
        VersionRef {
            store_path: store,
            modified_ms,
            device: Some(device.to_string()),
        }
    }

    #[test]
    fn multi_version_clean_folds_keep_every_side() {
        // Three devices appended apart: both fold steps stay clean, all
        // three tails land, and nothing is marked.
        let root = graph();
        write(root.path(), "daily/2026-07-04.md", "- seed\n- mac line\n");
        let shadow = ShadowStore::new(root.path());
        shadow.record("daily/2026-07-04.md", "- seed\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "daily/2026-07-04.md",
            3_000,
            vec![
                fake_version(
                    root.path(),
                    "v-phone.md",
                    "- seed\n- phone line\n",
                    1_000,
                    "iPhone",
                ),
                fake_version(
                    root.path(),
                    "v-ipad.md",
                    "- seed\n- ipad line\n",
                    2_000,
                    "iPad",
                ),
            ],
            &shadow,
        )
        .unwrap();

        assert!(!resolution.marked);
        for line in ["- mac line", "- phone line", "- ipad line"] {
            assert!(
                resolution.final_content.contains(line),
                "lost {line} in: {}",
                resolution.final_content
            );
        }
    }

    #[test]
    fn multi_version_overlap_stacks_every_side_instead_of_dropping_one() {
        // Overlapping edits across three devices: the fold must not let an
        // intermediate marker result meet the marked-side rule (which would
        // keep only the newest raw side) — every side stays in the note, as
        // stacked blocks the existing splice grammar can resolve.
        let root = graph();
        write(root.path(), "notes/a.md", "wording from mac\n");
        let shadow = ShadowStore::new(root.path());
        shadow.record("notes/a.md", "original wording\n").unwrap();

        let resolution = resolve_file(
            root.path(),
            "notes/a.md",
            3_000,
            vec![
                fake_version(
                    root.path(),
                    "v1.md",
                    "wording from phone\n",
                    1_000,
                    "iPhone",
                ),
                fake_version(root.path(), "v2.md", "wording from ipad\n", 2_000, "iPad"),
            ],
            &shadow,
        )
        .unwrap();

        assert!(resolution.marked);
        assert!(markers::contains_conflict_markers(
            &resolution.final_content
        ));
        for wording in [
            "wording from mac",
            "wording from phone",
            "wording from ipad",
        ] {
            assert!(
                resolution.final_content.contains(wording),
                "lost {wording} in: {}",
                resolution.final_content
            );
        }
        // Two stacked blocks for three sides — flat, never nested.
        assert_eq!(resolution.final_content.matches("<<<<<<< ").count(), 2);
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
                fake_version(root, "va.md", first, 1_000, "iPhone"),
                fake_version(root, "vb.md", second, 1_000, "iPad"),
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
    fn multi_version_with_a_marked_side_keeps_the_deterministic_newest() {
        // A side already carrying markers can't be stacked (nesting corrupts
        // the grammar): the two-way marked-side rule extends to n sides.
        let root = graph();
        let marked = "<<<<<<< Mac\nmine\n=======\ntheirs\n>>>>>>> iPhone\n";
        write(root.path(), "notes/a.md", "current clean\n");
        let shadow = ShadowStore::new(root.path());

        let resolution = resolve_file(
            root.path(),
            "notes/a.md",
            2_000,
            vec![
                fake_version(root.path(), "v1.md", marked, 1_000, "iPhone"),
                fake_version(root.path(), "v2.md", "newest clean\n", 3_000, "iPad"),
            ],
            &shadow,
        )
        .unwrap();

        assert_eq!(resolution.final_content, "newest clean\n");
        assert!(!resolution.marked);
    }
}
