//! Reflect V1 export import.
//!
//! Reflect V1 now exports the same markdown graph layout Reflect Open reads:
//! `daily/`, `notes/`, optional `assets/`, plus ignorable local metadata. The
//! import path is therefore a bounded archive extraction into the active graph,
//! not a content migration — with one addition: attachments the notes link
//! straight to Firebase Storage are downloaded into `assets/` and the links
//! rewritten (see [`super::import_assets`]).
//!
//! The flow is three phases so nothing lands in the graph until everything is
//! in hand: [`prepare_zip_import`] (read + validate, no writes), the async
//! [`PreparedImport::download_assets`] (network, staging writes only), then
//! [`finalize_import`] (rewrite, atomic writes).
//!
//! Existing graph files never make an import fail, and are never replaced:
//! identical files are skipped, a conflicting note lands under a `-2`-style
//! suffixed name (note links resolve by title, so the filename is free to
//! move), a conflicting daily note has the imported entry's body appended
//! (one day, one note — the merge is idempotent across re-imports), and a
//! conflicting asset lands suffixed with the imported notes' literal
//! `assets/…` links rewritten to follow it. Every real V1 import hits at
//! least one conflict (a fresh graph seeds `notes/how-to-use-reflect.md`,
//! which V1 exports also carry), so a fatal conflict policy would fail
//! practically every import.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::import_assets::{self, DownloadOutcome};
use super::io::{atomic_write_bytes, file_occupied};
use super::resolve::resolve;

/// Summary returned to the settings UI after an import completes.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Zip files newly written to the open graph.
    pub imported_files: usize,
    /// Zip files already present with identical bytes, left untouched.
    pub skipped_files: usize,
    /// Remote attachments now stored locally under `assets/` (whether newly
    /// written or already present from an earlier import).
    pub downloaded_assets: usize,
    /// Remote attachments that are permanently gone (4xx); their notes keep
    /// the remote link.
    pub failed_asset_downloads: usize,
    /// Zip files written under a `-2`-style suffixed name because their own
    /// name is held by a differing existing file — a genuine same-name file,
    /// or one the filesystem merely aliases to the same path
    /// (case-insensitive APFS folds `Füße.md`/`füsse.md`/`füße.md` together;
    /// the V1 export keeps them distinct notes). Renamed assets have the
    /// imported notes' `assets/…` links rewritten to the suffixed name.
    pub renamed_files: usize,
    /// Existing daily notes that gained the imported entry's body: the day
    /// already had a note with different content, so the import appends
    /// rather than duplicating the day under a suffixed name.
    pub merged_files: usize,
    /// Graph-relative paths written to the open graph (new files and merged
    /// daily notes).
    pub changed_paths: Vec<String>,
}

/// Progress of the running import, emitted to the frontend as
/// `import:progress` events (`stage` is `"downloading"` or `"writing"`).
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
}

/// Cooperative cancellation for the single running import, managed as Tauri
/// state. `begin` claims the one import slot and rearms the flag;
/// `graph_import_cancel` trips it. Downloads stop promptly and the import
/// aborts *before any graph write* — cancellation never leaves a
/// half-imported graph.
#[derive(Default)]
pub struct ImportCancel {
    cancelled: Arc<AtomicBool>,
    running: AtomicBool,
}

impl ImportCancel {
    /// Claim the import slot and rearm the cancel flag. Errors when an
    /// import is already running: a second import beginning would clear a
    /// cancel meant for the first, and concurrent imports are not
    /// serialized anywhere else.
    pub fn begin(&self) -> AppResult<ImportRunGuard<'_>> {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::io("an import is already running"));
        }
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(ImportRunGuard(self))
    }

    /// Request cancellation of the running import.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// The shared flag, for the download workers.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    /// Error out if cancellation was requested (checked between phases).
    pub fn ensure_active(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AppError::io("import cancelled"));
        }
        Ok(())
    }
}

/// Releases the import slot when the import command returns (any path).
pub struct ImportRunGuard<'a>(&'a ImportCancel);

impl Drop for ImportRunGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

struct ImportEntry {
    relative: String,
    bytes: Vec<u8>,
}

/// A validated export, read out of the zip but not yet written anywhere.
pub struct PreparedImport {
    entries: Vec<ImportEntry>,
    staging: PathBuf,
    /// Unique remote-asset URLs across all notes, in first-seen order (which
    /// also fixes collision-suffix assignment).
    urls: Vec<String>,
    prefix: String,
}

impl PreparedImport {
    /// Download every remote attachment into the graph's staging directory.
    /// Transient failures abort (nothing has been written to the graph yet);
    /// permanent 4xx failures come back as [`DownloadOutcome::Gone`].
    /// `cancelled` stops the workers between fetches; `on_progress` receives
    /// `(completed, total)` after each download settles.
    pub async fn download_assets(
        &self,
        cancelled: Arc<AtomicBool>,
        on_progress: Arc<dyn Fn(usize, usize) + Send + Sync>,
    ) -> AppResult<HashMap<String, DownloadOutcome>> {
        import_assets::download_remote_assets(
            &self.staging,
            self.urls.clone(),
            cancelled,
            on_progress,
        )
        .await
    }

    /// How many remote attachments the export links (the download total).
    pub fn remote_asset_count(&self) -> usize {
        self.urls.len()
    }
}

/// Read and validate a user-selected Reflect V1 export zip against `root`,
/// without writing anything.
pub(super) fn prepare_zip_import(root: &Path, zip_path: &Path) -> AppResult<PreparedImport> {
    prepare_zip_import_from(root, zip_path, import_assets::V1_ASSET_URL_PREFIX)
}

/// [`prepare_zip_import`] with the remote-asset URL prefix injectable, so
/// tests can point it at a local server.
fn prepare_zip_import_from(
    root: &Path,
    zip_path: &Path,
    prefix: &str,
) -> AppResult<PreparedImport> {
    let entries = dedupe_entries(read_zip_entries(zip_path)?)?;
    ensure_has_notes(&entries)?;
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    for entry in &entries {
        if !is_note_markdown(&entry.relative) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&entry.bytes) else {
            continue;
        };
        for span in import_assets::scan_remote_spans(text, prefix) {
            if seen.insert(span.url.clone()) {
                urls.push(span.url);
            }
        }
    }
    Ok(PreparedImport {
        entries,
        staging: super::assets::staging_dir(root)?,
        urls,
        prefix: prefix.to_string(),
    })
}

/// Two distinct URLs can serve the same attachment (V1 stored one upload per
/// link). When a download matches an already-planned asset's name and bytes,
/// both links share that one file instead of persisting a `-2` duplicate.
fn planned_duplicate(
    planned: &[(import_assets::FetchedAsset, import_assets::PlannedAssetName)],
    fetched: &import_assets::FetchedAsset,
) -> AppResult<Option<String>> {
    for (prior, plan) in planned {
        if prior.desired_name == fetched.desired_name
            && import_assets::same_file_bytes(prior.file.as_ref(), fetched.file.as_ref())?
        {
            return Ok(Some(plan.name.clone()));
        }
    }
    Ok(None)
}

fn ensure_has_notes(entries: &[ImportEntry]) -> AppResult<()> {
    if !entries
        .iter()
        .any(|entry| is_note_markdown(&entry.relative))
    {
        return Err(AppError::not_found(
            "that doesn't look like a Reflect V1 export — no notes found under daily/ or notes/",
        ));
    }
    Ok(())
}

/// Localize the downloaded attachments, write the zip's assets (renaming
/// conflicting ones), rewrite the notes' links (renamed `assets/…` paths and
/// downloaded remote URLs), then write the notes. Existing files are never
/// replaced and never fail the import: identical bytes are skipped, a
/// conflicting note lands under a suffixed name (whether the collision is a
/// genuine same-name file or a filesystem alias — case-insensitive APFS folds
/// `füße.md` and `füsse.md` to the same path), and a conflicting daily note
/// has the imported body appended instead. `on_progress` receives
/// `(processed, total)` per zip entry for the writing stage.
pub(super) fn finalize_import(
    root: &Path,
    prepared: PreparedImport,
    mut outcomes: HashMap<String, DownloadOutcome>,
    mut on_progress: impl FnMut(usize, usize),
) -> AppResult<ImportSummary> {
    let PreparedImport {
        mut entries,
        urls,
        prefix,
        ..
    } = prepared;

    let assets_dir = root.join("assets");
    let mut url_replacements = HashMap::new();
    let mut planned: Vec<(import_assets::FetchedAsset, import_assets::PlannedAssetName)> =
        Vec::new();
    // Downloads must not take asset names the zip itself will write.
    let mut taken = entries
        .iter()
        .filter_map(|entry| entry.relative.strip_prefix("assets/"))
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut downloaded_assets = 0;
    let mut failed_asset_downloads = 0;
    for url in &urls {
        match outcomes.remove(url) {
            Some(DownloadOutcome::Fetched(fetched)) => {
                downloaded_assets += 1;
                if let Some(name) = planned_duplicate(&planned, &fetched)? {
                    url_replacements.insert(url.clone(), format!("assets/{name}"));
                    continue;
                }
                let plan = import_assets::plan_asset_name(
                    &assets_dir,
                    &fetched.desired_name,
                    fetched.file.as_ref(),
                    &taken,
                )?;
                taken.insert(plan.name.clone());
                url_replacements.insert(url.clone(), format!("assets/{}", plan.name));
                planned.push((fetched, plan));
            }
            Some(DownloadOutcome::Gone) => failed_asset_downloads += 1,
            None => {}
        }
    }

    let mut imported_files = 0;
    let mut skipped_files = 0;
    let mut renamed_files = 0;
    let mut merged_files = 0;
    let mut changed_paths = Vec::new();
    for (fetched, plan) in planned {
        if plan.reuse {
            continue;
        }
        import_assets::persist_planned(fetched, &assets_dir, &plan.name)?;
        changed_paths.push(format!("assets/{}", plan.name));
    }

    let claimed = entries
        .iter()
        .map(|entry| entry.relative.clone())
        .collect::<HashSet<_>>();
    let mut names = DirNames::default();
    let total = entries.len();
    let mut processed = 0;

    // Non-note files first (assets a note links must exist — and be named —
    // before the note is rewritten and written).
    let mut path_replacements = HashMap::new();
    for entry in &entries {
        if is_note_markdown(&entry.relative) {
            continue;
        }
        match plan_other_entry(root, entry, &claimed)? {
            EntryPlan::SkipIdentical => skipped_files += 1,
            EntryPlan::Write { relative, renamed } => {
                let target = resolve(root, &relative)?;
                atomic_write_bytes(root, &target, &entry.bytes)?;
                names.record(&target);
                imported_files += 1;
                if renamed {
                    renamed_files += 1;
                    if entry.relative.starts_with("assets/") {
                        path_replacements.insert(entry.relative.clone(), relative.clone());
                    }
                }
                changed_paths.push(relative);
            }
        }
        processed += 1;
        on_progress(processed, total);
    }

    if !url_replacements.is_empty() || !path_replacements.is_empty() {
        for entry in &mut entries {
            if !is_note_markdown(&entry.relative) {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&entry.bytes) else {
                continue;
            };
            // Zip-borne `assets/…` links first: the remote rewrite splices in
            // downloaded assets' final names, which must not be re-mapped.
            let rewritten = import_assets::rewrite_asset_paths(text, &path_replacements);
            let rewritten = import_assets::rewrite_markdown(&rewritten, &prefix, &url_replacements);
            if rewritten != text {
                entry.bytes = rewritten.into_bytes();
            }
        }
    }

    for entry in &entries {
        if !is_note_markdown(&entry.relative) {
            continue;
        }
        match plan_note_entry(root, entry, &mut names, &claimed)? {
            NotePlan::SkipIdentical => skipped_files += 1,
            NotePlan::Write { relative, renamed } => {
                let target = resolve(root, &relative)?;
                atomic_write_bytes(root, &target, &entry.bytes)?;
                names.record(&target);
                imported_files += 1;
                if renamed {
                    renamed_files += 1;
                }
                changed_paths.push(relative);
            }
            NotePlan::Merge { merged } => {
                let target = resolve(root, &entry.relative)?;
                atomic_write_bytes(root, &target, &merged)?;
                merged_files += 1;
                changed_paths.push(entry.relative.clone());
            }
        }
        processed += 1;
        on_progress(processed, total);
    }

    Ok(ImportSummary {
        imported_files,
        skipped_files,
        downloaded_assets,
        failed_asset_downloads,
        renamed_files,
        merged_files,
        changed_paths,
    })
}

fn dedupe_entries(entries: Vec<ImportEntry>) -> AppResult<Vec<ImportEntry>> {
    let mut positions = HashMap::<String, usize>::new();
    let mut unique = Vec::<ImportEntry>::new();
    for entry in entries {
        if let Some(existing) = positions.get(&entry.relative) {
            if unique[*existing].bytes != entry.bytes {
                return Err(AppError::io(format!(
                    "import zip contains conflicting entries for {}",
                    entry.relative
                )));
            }
            continue;
        }
        positions.insert(entry.relative.clone(), unique.len());
        unique.push(entry);
    }
    Ok(unique)
}

enum EntryPlan {
    /// Write the entry at `relative` — its own name, or a suffixed one when
    /// a differing existing file (genuine, filesystem-aliased, or an evicted
    /// iCloud placeholder whose content is unknowable) holds its name.
    Write { relative: String, renamed: bool },
    /// The entry's bytes are already in the graph; leave the file untouched.
    SkipIdentical,
}

enum NotePlan {
    /// As [`EntryPlan::Write`].
    Write { relative: String, renamed: bool },
    /// As [`EntryPlan::SkipIdentical`] — including a daily entry whose body
    /// an earlier import already merged into the existing daily note.
    SkipIdentical,
    /// A daily note for this day already exists with different content:
    /// write `merged` (the existing note plus the imported body) in place.
    Merge { merged: Vec<u8> },
}

/// Directory listings cached per parent, to tell a true same-name file from
/// a filesystem alias: on case-insensitive volumes `Path::exists` also
/// matches names that differ only by case folding (macOS APFS folds `ß` to
/// `ss`, so `füße.md` and `füsse.md` are one path), which Reflect treats as
/// distinct notes. Listings are cached lazily per directory; writes must be
/// recorded via [`DirNames::record`] to keep a loaded listing current.
#[derive(Default)]
struct DirNames(HashMap<PathBuf, HashSet<OsString>>);

impl DirNames {
    /// Does `target`'s parent directory contain an entry with exactly this
    /// name (byte-for-byte, not just filesystem-equal)?
    fn contains(&mut self, target: &Path) -> AppResult<bool> {
        let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
            return Ok(false);
        };
        if let Some(names) = self.0.get(parent) {
            return Ok(names.contains(name));
        }
        let mut names = HashSet::new();
        if parent.is_dir() {
            for entry in fs::read_dir(parent)? {
                names.insert(entry?.file_name());
            }
        }
        let found = names.contains(name);
        self.0.insert(parent.to_path_buf(), names);
        Ok(found)
    }

    fn record(&mut self, target: &Path) {
        let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
            return;
        };
        if let Some(names) = self.0.get_mut(parent) {
            names.insert(name.to_os_string());
        }
    }
}

/// Far beyond any real graph's same-name population; hitting it means the
/// probe is lying, and failing loud beats spinning.
const MAX_RENAME_PROBES: usize = 1000;

/// Decide what writing a non-note `entry` should do given the current disk
/// state: its own name when free, skip when identical, a suffixed name when
/// a differing file holds it. `claimed` holds every relative path the import
/// will write under its own name, so a rename never takes a name a later
/// entry owns.
fn plan_other_entry(
    root: &Path,
    entry: &ImportEntry,
    claimed: &HashSet<String>,
) -> AppResult<EntryPlan> {
    let target = resolve(root, &entry.relative)?;
    if !target.exists() && !file_occupied(&target) {
        return Ok(EntryPlan::Write {
            relative: entry.relative.clone(),
            renamed: false,
        });
    }
    if target.is_file() && fs::read(&target)? == entry.bytes {
        return Ok(EntryPlan::SkipIdentical);
    }
    suffixed_plan(root, entry, claimed)
}

/// Decide what writing a note `entry` should do. Same policy as
/// [`plan_other_entry`], with one refinement: a *genuinely* same-named daily
/// note merges (one day, one note) instead of renaming — a suffixed filename
/// would fall out of the daily stream, whose dates parse from `YYYY-MM-DD.md`
/// names. A merely filesystem-aliased name is a distinct note and renames.
fn plan_note_entry(
    root: &Path,
    entry: &ImportEntry,
    names: &mut DirNames,
    claimed: &HashSet<String>,
) -> AppResult<NotePlan> {
    let target = resolve(root, &entry.relative)?;
    if !target.exists() && !file_occupied(&target) {
        return Ok(NotePlan::Write {
            relative: entry.relative.clone(),
            renamed: false,
        });
    }
    if target.is_file() && fs::read(&target)? == entry.bytes {
        return Ok(NotePlan::SkipIdentical);
    }
    if is_daily_note(&entry.relative) && target.is_file() && names.contains(&target)? {
        let existing = fs::read(&target)?;
        if let Some(plan) = plan_daily_merge(&existing, &entry.bytes) {
            return Ok(plan);
        }
    }
    match suffixed_plan(root, entry, claimed)? {
        EntryPlan::Write { relative, renamed } => Ok(NotePlan::Write { relative, renamed }),
        EntryPlan::SkipIdentical => Ok(NotePlan::SkipIdentical),
    }
}

/// Probe `entry.relative`'s `-2`-style suffixed names for a free one (or an
/// identical existing copy, from an earlier import's rename).
fn suffixed_plan(
    root: &Path,
    entry: &ImportEntry,
    claimed: &HashSet<String>,
) -> AppResult<EntryPlan> {
    for suffix in 2..MAX_RENAME_PROBES {
        let candidate = suffixed_relative(&entry.relative, suffix);
        if claimed.contains(&candidate) {
            continue;
        }
        let candidate_target = resolve(root, &candidate)?;
        if candidate_target.exists() {
            if candidate_target.is_file() && fs::read(&candidate_target)? == entry.bytes {
                return Ok(EntryPlan::SkipIdentical);
            }
            continue;
        }
        if file_occupied(&candidate_target) {
            continue;
        }
        return Ok(EntryPlan::Write {
            relative: candidate,
            renamed: true,
        });
    }
    Err(AppError::io(format!(
        "import could not find a collision-free name for {}",
        entry.relative
    )))
}

/// The merge (or skip) for a daily entry whose day already has a differing
/// note, or `None` when the contents don't merge cleanly (either side isn't
/// UTF-8) and the caller should fall back to a rename.
///
/// The appended body drops the imported entry's frontmatter (the existing
/// note keeps its identity) and its leading H1 (both apps render the day as
/// an H1 first line — appending it verbatim would repeat the date heading
/// mid-note). An empty remainder, or one the existing note already contains
/// (a re-import after an earlier merge), skips instead — the merge is
/// idempotent.
fn plan_daily_merge(existing: &[u8], imported: &[u8]) -> Option<NotePlan> {
    let existing = std::str::from_utf8(existing).ok()?;
    let imported = std::str::from_utf8(imported).ok()?;
    let body = without_leading_h1(without_frontmatter(imported)).trim();
    if body.is_empty() || existing.contains(body) {
        return Some(NotePlan::SkipIdentical);
    }
    let merged = format!("{}\n\n{}\n", existing.trim_end(), body);
    Some(NotePlan::Merge {
        merged: merged.into_bytes(),
    })
}

/// The text after a leading `---`-fenced frontmatter block, or all of it
/// when no complete fence opens the file.
fn without_frontmatter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n") else {
        return text;
    };
    match rest.find("\n---\n") {
        Some(end) => &rest[end + "\n---\n".len()..],
        None => match rest.strip_suffix("\n---") {
            Some(_) => "",
            None => text,
        },
    }
}

/// The text after a leading H1 line (`# …` as the first non-empty line), or
/// all of it when the file opens with anything else.
fn without_leading_h1(text: &str) -> &str {
    let trimmed = text.trim_start_matches(['\n', '\r']);
    if !trimmed.starts_with("# ") {
        return text;
    }
    match trimmed.find('\n') {
        Some(end) => &trimmed[end + 1..],
        None => "",
    }
}

/// Is this relative path a daily note (`daily/YYYY-MM-DD.md`)? Mirrors the
/// frontend's `DAILY_PATH_RE` — only dated names are part of the daily
/// stream; anything else under `daily/` is an ordinary note.
fn is_daily_note(relative: &str) -> bool {
    let Some(stem) = relative
        .strip_prefix("daily/")
        .and_then(|name| name.strip_suffix(".md"))
    else {
        return false;
    };
    stem.len() == 10
        && stem.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// `notes/füße.md` + 2 → `notes/füße-2.md` — the `-2` collision suffix the
/// rest of the app uses for note filenames (`availableNotePath`).
fn suffixed_relative(relative: &str, suffix: usize) -> String {
    let (dir, name) = match relative.rsplit_once('/') {
        Some((dir, name)) => (Some(dir), name),
        None => (None, relative),
    };
    let renamed = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}-{suffix}.{extension}"),
        _ => format!("{name}-{suffix}"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

fn read_zip_entries(path: &Path) -> AppResult<Vec<ImportEntry>> {
    let file = fs::File::open(path).map_err(|err| {
        AppError::io(format!(
            "could not open Reflect V1 export {}: {err}",
            path.display()
        ))
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| AppError::io(format!("could not read the zip: {err}")))?;

    let mut names = Vec::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|err| AppError::io(format!("could not read a zip entry: {err}")))?;
        if file.is_dir() {
            continue;
        }
        if let Some(name) = file.enclosed_name() {
            names.push(normalize_zip_path(&name.to_string_lossy()));
        }
    }

    let prefix = wrapper_prefix(&names);
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| AppError::io(format!("could not read a zip entry: {err}")))?;
        if file.is_dir() {
            continue;
        }
        let Some(name) = file.enclosed_name() else {
            continue;
        };
        let name = normalize_zip_path(&name.to_string_lossy());
        let Some(relative) = sanitized_relative(&name, prefix.as_deref()) else {
            continue;
        };
        let mut bytes = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|err| AppError::io(format!("could not extract {relative}: {err}")))?;
        entries.push(ImportEntry { relative, bytes });
    }
    Ok(entries)
}

fn normalize_zip_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// A single wrapping directory commonly added by zip tools:
/// `export/notes/a.md` should import as `notes/a.md`.
fn wrapper_prefix(paths: &[String]) -> Option<String> {
    let mut shared: Option<&str> = None;
    for path in paths {
        let parts = parts(path);
        if is_ignored_wrapper_noise(&parts) {
            continue;
        }
        let first = *parts.first()?;
        match shared {
            None => shared = Some(first),
            Some(existing) if existing == first => {}
            Some(_) => return None,
        }
    }
    let shared = shared?;
    if matches!(shared, "daily" | "notes" | "assets" | ".reflect") {
        return None;
    }
    Some(shared.to_string())
}

fn sanitized_relative(raw: &str, prefix: Option<&str>) -> Option<String> {
    if raw.starts_with('/') || raw.contains('\0') {
        return None;
    }
    let normalized = normalize_zip_path(raw);
    let mut parts = parts(&normalized);
    if parts.contains(&"..") {
        return None;
    }
    if let Some(prefix) = prefix {
        if parts.first() == Some(&prefix) {
            parts.remove(0);
        }
    }
    if is_ignored_wrapper_noise(&parts) {
        return None;
    }
    let first = *parts.first()?;
    let last = *parts.last()?;
    if matches!(first, ".reflect" | ".git" | "__MACOSX") || is_junk(last) {
        return None;
    }
    Some(parts.join("/"))
}

fn parts(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect()
}

fn is_ignored_wrapper_noise(parts: &[&str]) -> bool {
    match parts {
        [] => true,
        [".gitignore"] => true,
        [name] if is_junk(name) => true,
        [first, ..] if *first == "__MACOSX" => true,
        _ => false,
    }
}

fn is_junk(name: &str) -> bool {
    name == ".DS_Store"
        || name == "Thumbs.db"
        || name == "Desktop.ini"
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with('~')
}

fn is_note_markdown(relative: &str) -> bool {
    let mut parts = relative.split('/');
    let Some(first) = parts.next() else {
        return false;
    };
    matches!(first, "daily" | "notes")
        && Path::new(relative)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn entries(pairs: &[(&str, &str)]) -> Vec<ImportEntry> {
        pairs
            .iter()
            .filter_map(|(path, contents)| {
                sanitized_relative(path, None).map(|relative| ImportEntry {
                    relative,
                    bytes: contents.as_bytes().to_vec(),
                })
            })
            .collect()
    }

    /// The old single-call import shape, for tests that exercise extraction
    /// and collision policy without remote assets.
    fn import_entries_into_graph(
        root: &Path,
        entries: Vec<ImportEntry>,
    ) -> AppResult<ImportSummary> {
        let entries = dedupe_entries(entries)?;
        ensure_has_notes(&entries)?;
        let prepared = PreparedImport {
            entries,
            staging: super::super::assets::staging_dir(root)?,
            urls: Vec::new(),
            prefix: import_assets::V1_ASSET_URL_PREFIX.to_string(),
        };
        finalize_import(root, prepared, HashMap::new(), |_, _| {})
    }

    fn import_zip_into_graph(root: &Path, zip_path: &Path) -> AppResult<ImportSummary> {
        let prepared = prepare_zip_import(root, zip_path)?;
        finalize_import(root, prepared, HashMap::new(), |_, _| {})
    }

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn no_progress() -> Arc<dyn Fn(usize, usize) + Send + Sync> {
        Arc::new(|_, _| {})
    }

    fn write_zip(path: &Path, pairs: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, contents) in pairs {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    /// Serve canned HTTP responses on a local port: each entry is
    /// `(path, status line, extra headers, body)`. Handles connections until
    /// the expected request count is reached.
    fn serve(
        responses: Vec<(&'static str, &'static str, &'static str, &'static [u8])>,
        expected_requests: usize,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..expected_requests {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                }
                let requested = request_line.split_whitespace().nth(1).unwrap_or("");
                let mut stream = reader.into_inner();
                match responses.iter().find(|(path, ..)| *path == requested) {
                    Some((_, status, headers, body)) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                        );
                    }
                }
            }
        });
        base
    }

    fn serve_generated_assets(expected_requests: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..expected_requests {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                }
                let requested = request_line.split_whitespace().nth(1).unwrap_or("");
                let body = requested.as_bytes();
                let mut stream = reader.into_inner();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        base
    }

    #[cfg(unix)]
    fn open_fd_count() -> Option<usize> {
        ["/proc/self/fd", "/dev/fd"]
            .into_iter()
            .find_map(|path| fs::read_dir(path).ok().map(|entries| entries.count()))
    }

    #[test]
    fn imports_notes_into_the_open_graph() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/a.md", "# A\n"),
                ("daily/2026-07-04.md", "Today\n"),
                ("assets/pic.bin", "raw"),
            ]),
        )
        .unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 3,
                skipped_files: 0,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                renamed_files: 0,
                merged_files: 0,
                // Non-note files land first: an asset must exist (and be
                // named) before the notes that link it are written.
                changed_paths: vec![
                    "assets/pic.bin".to_string(),
                    "notes/a.md".to_string(),
                    "daily/2026-07-04.md".to_string()
                ],
            }
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# A\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "Today\n"
        );
        assert_eq!(
            fs::read(root.path().join("assets/pic.bin")).unwrap(),
            b"raw"
        );
    }

    #[test]
    fn skips_metadata_and_strips_a_wrapper_directory() {
        let root = tempdir().unwrap();
        let zip_path = root.path().join("export.zip");
        write_zip(
            &zip_path,
            &[
                ("Reflect/.gitignore", "ignored"),
                ("Reflect/.reflect/index.sqlite", "stale"),
                ("Reflect/.git/config", "git"),
                ("Reflect/notes/.DS_Store", "junk"),
                ("Reflect/notes/a.md", "# A\n"),
            ],
        );

        let summary = import_zip_into_graph(root.path(), &zip_path).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert!(root.path().join("notes/a.md").is_file());
        assert!(!root.path().join(".reflect/index.sqlite").exists());
        assert!(!root.path().join(".git/config").exists());
        assert!(!root.path().join("notes/.DS_Store").exists());
    }

    /// The reported migration blocker: a fresh graph seeds
    /// `notes/how-to-use-reflect.md` and every V1 export carries its own
    /// differing copy, so a fatal conflict policy failed practically every
    /// import. A conflicting note now lands under a suffixed name, with the
    /// existing note untouched.
    #[test]
    fn conflicting_notes_import_under_suffixed_names() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")])).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(summary.changed_paths, vec!["notes/a-2.md".to_string()]);
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Mine\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a-2.md")).unwrap(),
            "# V1\n"
        );
    }

    /// A conflicting daily note merges instead of renaming — one day, one
    /// note (a suffixed daily filename would fall out of the daily stream).
    /// The imported entry's duplicate date heading is dropped.
    #[test]
    fn conflicting_daily_notes_merge_into_the_existing_note() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("daily")).unwrap();
        fs::write(
            root.path().join("daily/2026-07-04.md"),
            "# July 4th, 2026\n\n- written in V2\n",
        )
        .unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[(
                "daily/2026-07-04.md",
                "---\nid: abc\n---\n\n# July 4th, 2026\n\n- written in V1\n",
            )]),
        )
        .unwrap();

        assert_eq!(summary.imported_files, 0);
        assert_eq!(summary.merged_files, 1);
        assert_eq!(
            summary.changed_paths,
            vec!["daily/2026-07-04.md".to_string()]
        );
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# July 4th, 2026\n\n- written in V2\n\n- written in V1\n"
        );
    }

    /// Re-importing the same export after a daily merge must not append the
    /// body again.
    #[test]
    fn reimporting_after_a_daily_merge_is_idempotent() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("daily")).unwrap();
        fs::write(
            root.path().join("daily/2026-07-04.md"),
            "# July 4th, 2026\n\n- written in V2\n",
        )
        .unwrap();
        let pairs = [(
            "daily/2026-07-04.md",
            "# July 4th, 2026\n\n- written in V1\n",
        )];
        import_entries_into_graph(root.path(), entries(&pairs)).unwrap();

        let second = import_entries_into_graph(root.path(), entries(&pairs)).unwrap();

        assert_eq!(second.merged_files, 0);
        assert_eq!(second.skipped_files, 1);
        assert!(second.changed_paths.is_empty());
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# July 4th, 2026\n\n- written in V2\n\n- written in V1\n"
        );
    }

    /// A daily entry that is nothing but its date heading (and frontmatter)
    /// has no body to merge — the existing note stays untouched.
    #[test]
    fn empty_daily_bodies_do_not_merge() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("daily")).unwrap();
        fs::write(
            root.path().join("daily/2026-07-04.md"),
            "# July 4th, 2026\n\n- kept\n",
        )
        .unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[("daily/2026-07-04.md", "# July 4th, 2026\n")]),
        )
        .unwrap();

        assert_eq!(summary.merged_files, 0);
        assert_eq!(summary.skipped_files, 1);
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "# July 4th, 2026\n\n- kept\n"
        );
    }

    /// Non-dated files under `daily/` are ordinary notes: conflicts rename
    /// rather than merge.
    #[test]
    fn undated_daily_conflicts_rename_instead_of_merging() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("daily")).unwrap();
        fs::write(root.path().join("daily/scratch.md"), "# Mine\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("daily/scratch.md", "# V1\n")]))
                .unwrap();

        assert_eq!(summary.renamed_files, 1);
        assert_eq!(summary.merged_files, 0);
        assert_eq!(
            fs::read_to_string(root.path().join("daily/scratch-2.md")).unwrap(),
            "# V1\n"
        );
    }

    /// Does the filesystem under `dir` treat `probe` as the same path as
    /// `existing`? True on macOS's case-insensitive APFS for case-only
    /// variants and for `ß`/`ss` (its case folding maps one to the other);
    /// false on case-sensitive filesystems, where the alias tests below
    /// have nothing to exercise and bow out.
    fn filesystem_folds(dir: &Path, existing: &str, probe: &str) -> bool {
        fs::write(dir.join(existing), b"probe").unwrap();
        let folded = dir.join(probe).exists();
        fs::remove_file(dir.join(existing)).unwrap();
        folded
    }

    fn note_file_names(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(root.join("notes"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    /// The reported German/Swiss bug: a V1 export holding both `füsse.md`
    /// and `füße.md` — distinct notes that macOS folds to one path — must
    /// import both, the aliased one under a `-2` suffix, instead of failing
    /// with "import would overwrite existing files".
    #[test]
    fn filesystem_aliased_names_import_under_suffixed_names() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        if !filesystem_folds(&root.path().join("notes"), "füsse.md", "füße.md") {
            return;
        }

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/füsse.md", "# Swiss\n"),
                ("notes/füße.md", "# German\n"),
            ]),
        )
        .unwrap();

        assert_eq!(summary.imported_files, 2);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(
            summary.changed_paths,
            vec!["notes/füsse.md".to_string(), "notes/füße-2.md".to_string()]
        );
        assert_eq!(
            note_file_names(root.path()),
            vec!["füsse.md".to_string(), "füße-2.md".to_string()]
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/füsse.md")).unwrap(),
            "# Swiss\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/füße-2.md")).unwrap(),
            "# German\n"
        );
    }

    #[test]
    fn reimporting_after_an_alias_rename_is_idempotent() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        if !filesystem_folds(&root.path().join("notes"), "füsse.md", "füße.md") {
            return;
        }
        let pairs = [
            ("notes/füsse.md", "# Swiss\n"),
            ("notes/füße.md", "# German\n"),
        ];
        import_entries_into_graph(root.path(), entries(&pairs)).unwrap();

        let second = import_entries_into_graph(root.path(), entries(&pairs)).unwrap();

        assert_eq!(second.imported_files, 0);
        assert_eq!(second.skipped_files, 2);
        assert_eq!(second.renamed_files, 0);
        assert_eq!(
            note_file_names(root.path()),
            vec!["füsse.md".to_string(), "füße-2.md".to_string()]
        );
    }

    /// A rename must not take a name a later zip entry owns: with
    /// `füße-2.md` in the export, the aliased `füße.md` skips to `-3`.
    #[test]
    fn alias_rename_never_takes_a_name_the_export_owns() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        if !filesystem_folds(&root.path().join("notes"), "füsse.md", "füße.md") {
            return;
        }

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/füsse.md", "# Swiss\n"),
                ("notes/füße.md", "# German\n"),
                ("notes/füße-2.md", "# Other\n"),
            ]),
        )
        .unwrap();

        assert_eq!(summary.imported_files, 3);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(
            fs::read_to_string(root.path().join("notes/füße-3.md")).unwrap(),
            "# German\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/füße-2.md")).unwrap(),
            "# Other\n"
        );
    }

    /// An existing graph note whose name merely case-aliases an entry is not
    /// an overwrite: the entry is a distinct note and lands suffixed.
    #[test]
    fn case_aliased_existing_note_gets_a_suffix_instead_of_a_refusal() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        if !filesystem_folds(&root.path().join("notes"), "API.md", "api.md") {
            return;
        }
        fs::write(root.path().join("notes/API.md"), "# Theirs\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/api.md", "# Mine\n")]))
                .unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(
            fs::read_to_string(root.path().join("notes/API.md")).unwrap(),
            "# Theirs\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/api-2.md")).unwrap(),
            "# Mine\n"
        );
    }

    /// A conflicting asset lands under a suffixed name, and the imported
    /// notes' literal `assets/…` links are rewritten to follow it — unlike
    /// note links (which resolve by title), asset links are paths.
    #[test]
    fn conflicting_assets_rename_and_imported_links_follow() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("assets")).unwrap();
        fs::write(root.path().join("assets/pic.bin"), b"theirs").unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/a.md", "![](assets/pic.bin)\n\nsee assets/pic.bin\n"),
                ("assets/pic.bin", "mine"),
            ]),
        )
        .unwrap();

        assert_eq!(summary.imported_files, 2);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(
            fs::read(root.path().join("assets/pic.bin")).unwrap(),
            b"theirs"
        );
        assert_eq!(
            fs::read(root.path().join("assets/pic-2.bin")).unwrap(),
            b"mine"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "![](assets/pic-2.bin)\n\nsee assets/pic-2.bin\n"
        );
    }

    /// The same policy covers names the filesystem merely aliases together
    /// (case-insensitive APFS): the aliased asset renames instead of failing.
    #[test]
    fn aliased_assets_rename_instead_of_failing() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("assets")).unwrap();
        if !filesystem_folds(&root.path().join("assets"), "PIC.bin", "pic.bin") {
            return;
        }
        fs::write(root.path().join("assets/PIC.bin"), b"theirs").unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/a.md", "![](assets/pic.bin)\n"),
                ("assets/pic.bin", "mine"),
            ]),
        )
        .unwrap();

        assert_eq!(summary.imported_files, 2);
        assert_eq!(summary.renamed_files, 1);
        assert_eq!(
            fs::read(root.path().join("assets/PIC.bin")).unwrap(),
            b"theirs"
        );
        assert_eq!(
            fs::read(root.path().join("assets/pic-2.bin")).unwrap(),
            b"mine"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "![](assets/pic-2.bin)\n"
        );
    }

    /// Identical bytes under an aliased name are already in the graph — skip
    /// them rather than minting a suffixed duplicate.
    #[test]
    fn identical_content_under_an_aliased_name_is_skipped() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        if !filesystem_folds(&root.path().join("notes"), "API.md", "api.md") {
            return;
        }
        fs::write(root.path().join("notes/API.md"), "# Same\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/api.md", "# Same\n")]))
                .unwrap();

        assert_eq!(summary.imported_files, 0);
        assert_eq!(summary.skipped_files, 1);
        assert_eq!(summary.renamed_files, 0);
        assert_eq!(note_file_names(root.path()), vec!["API.md".to_string()]);
    }

    #[test]
    fn identical_existing_files_are_skipped() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# Same\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# Same\n")])).unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 0,
                skipped_files: 1,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                renamed_files: 0,
                merged_files: 0,
                changed_paths: Vec::new(),
            }
        );
    }

    #[test]
    fn identical_duplicate_entries_import_once() {
        let root = tempdir().unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[("notes/a.md", "# Same\n"), ("notes/a.md", "# Same\n")]),
        )
        .unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 1,
                skipped_files: 0,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                renamed_files: 0,
                merged_files: 0,
                changed_paths: vec!["notes/a.md".to_string()],
            }
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Same\n"
        );
    }

    #[test]
    fn conflicting_duplicate_entries_reject_before_writing() {
        let root = tempdir().unwrap();

        let result = import_entries_into_graph(
            root.path(),
            entries(&[("notes/a.md", "# First\n"), ("notes/a.md", "# Second\n")]),
        );

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("conflicting entries")),
            other => panic!("expected a duplicate-entry IO error, got {other:?}"),
        }
        assert!(!root.path().join("notes/a.md").exists());
    }

    /// An evicted iCloud placeholder occupies its note's name with unknowable
    /// content — the entry renames rather than racing the download.
    #[test]
    fn evicted_icloud_placeholder_renames_the_entry() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/.a.md.icloud"), "placeholder").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")])).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.renamed_files, 1);
        assert!(!root.path().join("notes/a.md").exists());
        assert!(root.path().join("notes/.a.md.icloud").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a-2.md")).unwrap(),
            "# V1\n"
        );
    }

    #[test]
    fn rejects_archives_without_notes() {
        let root = tempdir().unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("assets/pic.bin", "raw")]));

        assert!(result.is_err());
        assert!(!root.path().join("assets/pic.bin").exists());
    }

    fn import_zip_downloading_from(
        root: &Path,
        zip_path: &Path,
        prefix: &str,
    ) -> AppResult<ImportSummary> {
        let prepared = prepare_zip_import_from(root, zip_path, prefix)?;
        let downloads =
            tauri::async_runtime::block_on(prepared.download_assets(no_cancel(), no_progress()))?;
        finalize_import(root, prepared, downloads, |_, _| {})
    }

    #[test]
    fn downloads_remote_assets_and_rewrites_links() {
        let root = tempdir().unwrap();
        let base = serve(
            vec![
                (
                    "/photo?alt=media&token=t",
                    "200 OK",
                    "Content-Type: image/webp\r\nContent-Disposition: inline; filename=\"Trip Photo.webp\"\r\n",
                    b"webp bytes",
                ),
                (
                    "/memo?alt=media&token=u",
                    "200 OK",
                    "Content-Type: audio/mp4\r\n",
                    b"audio bytes",
                ),
                (
                    "/users%2Fabc%2F9c2c28?alt=media&token=v",
                    "200 OK",
                    "Content-Type: image/png\r\nContent-Disposition: inline; filename*=utf-8''9c2c28\r\n",
                    b"png bytes",
                ),
            ],
            3,
        );
        let zip_path = root.path().join("export.zip");
        let markdown = format!(
            "![]({base}photo?alt=media\\&token=t)\n\n[memo.m4a]({base}memo?alt=media\\&token=u)\n\n![]({base}users%2Fabc%2F9c2c28?alt=media\\&token=v)\n"
        );
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, 3);
        assert_eq!(summary.failed_asset_downloads, 0);
        assert!(summary
            .changed_paths
            .contains(&"assets/trip-photo.webp".to_string()));
        assert!(summary
            .changed_paths
            .contains(&"assets/memo.m4a".to_string()));
        assert_eq!(
            fs::read(root.path().join("assets/trip-photo.webp")).unwrap(),
            b"webp bytes"
        );
        assert_eq!(
            fs::read(root.path().join("assets/memo.m4a")).unwrap(),
            b"audio bytes"
        );
        assert_eq!(
            fs::read(root.path().join("assets/9c2c28.png")).unwrap(),
            b"png bytes"
        );
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(
            note,
            "![](assets/trip-photo.webp)\n\n[memo.m4a](assets/memo.m4a)\n\n![](assets/9c2c28.png)\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn downloaded_assets_do_not_hold_file_descriptors_until_finalize() {
        const ASSET_COUNT: usize = 80;

        let root = tempdir().unwrap();
        let base = serve_generated_assets(ASSET_COUNT);
        let zip_path = root.path().join("export.zip");
        let markdown = (0..ASSET_COUNT)
            .map(|index| format!("![]({base}asset-{index}?alt=media\\&token={index})\n"))
            .collect::<String>();
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let prepared = prepare_zip_import_from(root.path(), &zip_path, &base).unwrap();
        let Some(before) = open_fd_count() else {
            return;
        };
        let downloads =
            tauri::async_runtime::block_on(prepared.download_assets(no_cancel(), no_progress()))
                .unwrap();
        let Some(after) = open_fd_count() else {
            return;
        };

        assert_eq!(downloads.len(), ASSET_COUNT);
        assert!(
            after.saturating_sub(before) < ASSET_COUNT / 4,
            "asset downloads kept too many file descriptors open: before {before}, after {after}"
        );

        let summary = finalize_import(root.path(), prepared, downloads, |_, _| {}).unwrap();
        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, ASSET_COUNT);
        assert_eq!(summary.failed_asset_downloads, 0);
        assert_eq!(
            summary
                .changed_paths
                .iter()
                .filter(|path| path.starts_with("assets/"))
                .count(),
            ASSET_COUNT
        );
    }

    #[test]
    fn identical_assets_under_one_name_share_one_file() {
        let root = tempdir().unwrap();
        let response: (&str, &str, &str, &[u8]) = (
            "",
            "200 OK",
            "Content-Type: image/png\r\nContent-Disposition: inline; filename=\"pic.png\"\r\n",
            b"png bytes",
        );
        let base = serve(
            vec![
                ("/a?alt=media&token=t", response.1, response.2, response.3),
                ("/b?alt=media&token=u", response.1, response.2, response.3),
            ],
            2,
        );
        let zip_path = root.path().join("export.zip");
        let markdown =
            format!("![]({base}a?alt=media\\&token=t)\n\n![]({base}b?alt=media\\&token=u)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.downloaded_assets, 2);
        let asset_paths: Vec<_> = summary
            .changed_paths
            .iter()
            .filter(|path| path.starts_with("assets/"))
            .collect();
        assert_eq!(asset_paths, ["assets/pic.png"]);
        assert!(!root.path().join("assets/pic-2.png").exists());
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(note, "![](assets/pic.png)\n\n![](assets/pic.png)\n");
    }

    #[test]
    fn gone_assets_keep_their_remote_links() {
        let root = tempdir().unwrap();
        let base = serve(vec![], 1);
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}deleted?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, 0);
        assert_eq!(summary.failed_asset_downloads, 1);
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(note, markdown);
        assert!(!root.path().join("assets").join("deleted").exists());
    }

    /// One import at a time: a second `begin` while the slot is held must
    /// error (it would clear a cancel meant for the running import), and the
    /// slot frees once the guard drops.
    #[test]
    fn a_second_import_cannot_begin_while_one_runs() {
        let cancel = ImportCancel::default();

        let guard = cancel.begin().unwrap();
        assert!(cancel.begin().is_err());

        cancel.cancel();
        drop(guard);
        let _rearmed = cancel.begin().unwrap();
        assert!(cancel.ensure_active().is_ok());
    }

    #[test]
    fn download_progress_reports_every_settled_url() {
        let root = tempdir().unwrap();
        let base = serve_generated_assets(3);
        let zip_path = root.path().join("export.zip");
        let markdown = (0..3)
            .map(|index| format!("![]({base}asset-{index}?alt=media\\&token={index})\n"))
            .collect::<String>();
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);
        let prepared = prepare_zip_import_from(root.path(), &zip_path, &base).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);

        tauri::async_runtime::block_on(prepared.download_assets(
            no_cancel(),
            Arc::new(move |done, total| record.lock().unwrap().push((done, total))),
        ))
        .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(seen.contains(&(3, 3)));
        assert!(seen.iter().all(|(_, total)| *total == 3));
    }

    /// A cancelled import stops downloading and errors before any graph
    /// write — the graph is untouched and the import can simply be rerun.
    #[test]
    fn cancelled_downloads_abort_before_any_write() {
        let root = tempdir().unwrap();
        let base = serve_generated_assets(1);
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}photo?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);
        let prepared = prepare_zip_import_from(root.path(), &zip_path, &base).unwrap();
        let cancelled = Arc::new(AtomicBool::new(true));

        let result =
            tauri::async_runtime::block_on(prepared.download_assets(cancelled, no_progress()));

        match result.err() {
            Some(AppError::Io { message }) => assert!(message.contains("cancelled")),
            other => panic!("expected a cancellation error, got {other:?}"),
        }
        assert!(!root.path().join("daily/2026-07-04.md").exists());
        assert!(!root.path().join("assets").exists());
    }

    #[test]
    fn write_progress_counts_every_entry() {
        let root = tempdir().unwrap();
        let entries = entries(&[
            ("notes/a.md", "# A\n"),
            ("daily/2026-07-04.md", "Today\n"),
            ("assets/pic.bin", "raw"),
        ]);
        let prepared = PreparedImport {
            entries: dedupe_entries(entries).unwrap(),
            staging: super::super::assets::staging_dir(root.path()).unwrap(),
            urls: Vec::new(),
            prefix: import_assets::V1_ASSET_URL_PREFIX.to_string(),
        };
        let mut seen = Vec::new();

        finalize_import(root.path(), prepared, HashMap::new(), |done, total| {
            seen.push((done, total))
        })
        .unwrap();

        assert_eq!(seen, vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn unreachable_asset_host_aborts_before_any_write() {
        let root = tempdir().unwrap();
        // Bind then drop, so the port refuses connections.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", dead.local_addr().unwrap());
        drop(dead);
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}photo?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let result = import_zip_downloading_from(root.path(), &zip_path, &base);

        assert!(matches!(result.unwrap_err(), AppError::Network { .. }));
        assert!(!root.path().join("daily/2026-07-04.md").exists());
    }

    #[test]
    fn reimporting_the_same_export_reuses_downloaded_assets() {
        let root = tempdir().unwrap();
        let base = serve(
            vec![(
                "/photo?alt=media&token=t",
                "200 OK",
                "Content-Type: image/png\r\nContent-Disposition: inline; filename=\"pic.png\"\r\n",
                b"png bytes",
            )],
            2,
        );
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}photo?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let first = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();
        assert_eq!(first.imported_files, 1);
        assert_eq!(first.downloaded_assets, 1);

        let second = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();
        assert_eq!(second.imported_files, 0);
        assert_eq!(second.skipped_files, 1);
        assert_eq!(second.downloaded_assets, 1);
        assert!(second.changed_paths.is_empty());
        assert!(!root.path().join("assets/pic-2.png").exists());
    }

    #[test]
    fn wrapper_prefix_ignores_root_metadata_noise() {
        assert_eq!(
            wrapper_prefix(&[
                ".DS_Store".to_string(),
                ".gitignore".to_string(),
                "export/notes/a.md".to_string()
            ]),
            Some("export".to_string())
        );
        assert_eq!(
            wrapper_prefix(&["notes/a.md".to_string(), "daily/2026-07-04.md".to_string()]),
            None
        );
    }
}
