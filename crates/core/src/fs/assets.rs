//! Asset intake: streamed uploads and file-to-file imports into `assets/`.
//!
//! Two ways bytes become a graph asset, both landing through one collision
//! policy ([`persist_unique`]) so a name is decided exactly once, race-free,
//! by the filesystem:
//!
//! - **Streamed upload** (`asset_upload_begin` / `_append` / `_commit` /
//!   `_abort`): the paste/drop path. The webview holds a `File` with no OS
//!   path, so bytes cross the IPC — as **raw request bodies** (no base64, no
//!   JSON), in chunks, into a temp file under `.reflect/tmp/` (excluded from
//!   indexing and sync, so the watcher never sees a half-written upload).
//!   Commit renames into `assets/`.
//! - **Import** (`asset_import`): the file-picker path. The source has a real
//!   OS path, so Rust copies file-to-file and the bytes never enter webview
//!   memory at all.
//!
//! Both are generation-pinned like every mutating command: a graph switch
//! mid-upload strands the temp file in the *old* graph's `.reflect/tmp/` and
//! the commit is rejected loudly.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use reflect_graph_io::io::{file_occupied, staging_dir};
use reflect_graph_io::{invalidate_file_catalog, resolve, root_for_generation, with_graph_lock};
use reflect_types::{AppError, AppResult};

use crate::Core;

/// Header carrying the upload id on `asset_upload_append` calls — raw-body
/// requests have no JSON args, so the id travels out-of-band.
pub const UPLOAD_ID_HEADER: &str = "x-upload-id";
/// Collision probes before giving up, mirroring `probeNotePath`'s cap.
const MAX_NAME_PROBES: u32 = 1000;

struct Upload {
    generation: u64,
    file: tempfile::NamedTempFile,
}

/// Registry of in-flight streamed uploads, keyed by upload id.
#[derive(Default)]
pub struct AssetUploads(Mutex<HashMap<String, Upload>>);

fn lock_uploads<'locked>(
    uploads: &'locked AssetUploads,
) -> AppResult<std::sync::MutexGuard<'locked, HashMap<String, Upload>>> {
    uploads.0.lock().map_err(|err| {
        tracing::error!(?err, "asset upload state lock poisoned by an earlier panic");
        AppError::io("asset upload state lock poisoned")
    })
}

/// Reject an asset filename that is empty, path-shaped, or a dot name. The
/// TypeScript layer sanitizes names for readability; this is the trust
/// boundary that keeps whatever arrives a single flat segment under `assets/`.
fn ensure_asset_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err(AppError::traversal(format!(
            "asset name must be a plain filename: {name:?}"
        )));
    }
    Ok(())
}

/// Split `name` into (stem, `.ext`) for suffix probing; the extension stays
/// attached through collisions (`report.pdf` → `report-2.pdf`).
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // A leading dot is a hidden file, not an extension.
        Some(idx) if idx > 0 => name.split_at(idx),
        _ => (name, ""),
    }
}

/// Persist `temp` under `assets_dir` as `desired`, probing `-2`, `-3`, …
/// suffixes until a name is free. `persist_noclobber` is the collision check
/// *and* the claim (`O_EXCL` semantics), so two concurrent intakes of the
/// same name can never clobber each other. Returns the winning filename.
fn persist_unique(
    mut temp: tempfile::NamedTempFile,
    assets_dir: &Path,
    desired: &str,
) -> AppResult<String> {
    temp.as_file().sync_all()?;
    let (stem, ext) = split_name(desired);
    for attempt in 1..=MAX_NAME_PROBES {
        let candidate = if attempt == 1 {
            desired.to_string()
        } else {
            format!("{stem}-{attempt}{ext}")
        };
        match temp.persist_noclobber(assets_dir.join(&candidate)) {
            Ok(_) => return Ok(candidate),
            Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = err.file;
            }
            Err(err) => return Err(AppError::io(err.to_string())),
        }
    }
    Err(AppError::io(format!(
        "no free asset name after {MAX_NAME_PROBES} probes for {desired}"
    )))
}

/// Resolved `assets/` directory for a commit/import destination, traversal-
/// guarded. Call it with the graph lock held.
fn assets_dir_for(root: &Path, name: &str) -> AppResult<std::path::PathBuf> {
    ensure_asset_name(name)?;
    // Resolve the target through the shared guard even though `name` is
    // already vetted — defense in depth, and it canonicalizes symlink games.
    resolve(root, &format!("assets/{name}"))?;
    let dir = root.join("assets");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Persist a staged upload at an exact target path, creating parent
/// directories. No-clobber: the temp file only ever *claims* a free path, so
/// a concurrent writer's file is never overwritten. Like [`persist_unique`],
/// fsyncs before the rename — durability is the persist helpers' job, never
/// their callers'.
fn persist_exact(temp: tempfile::NamedTempFile, target: &Path) -> AppResult<()> {
    // An iCloud-evicted file occupies its path through its `.icloud` stub
    // alone — `persist_noclobber` would happily claim the logical name and
    // collide with the re-download (Plan 21).
    if file_occupied(target) {
        return Err(AppError::io(format!(
            "target already exists: {}",
            target.display()
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    temp.as_file().sync_all()?;
    temp.persist_noclobber(target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// Copy `source` into the graph at `target`, staging the bytes under
/// `.reflect/tmp/` so the watcher never sees a partial file.
///
/// Idempotent by construction, in both directions: a segment's path encodes
/// its session and position, so an existing target *is* that same segment,
/// and a source that is already gone means an earlier ingest moved it (or a
/// cancelled session swept it away while this capture sat in the queue).
/// Neither is a failure worth parking the capture queue behind.
#[cfg(test)]
fn import_exact(source: &Path, staging: &Path, target: &Path) -> AppResult<()> {
    match stage_import(source, staging, target)? {
        Some(temp) => persist_import(temp, target),
        None => Ok(()),
    }
}

/// Copy `source` into `staging`. Returns `None` when there is nothing to
/// persist: the target is already taken or the source is gone.
fn stage_import(
    source: &Path,
    staging: &Path,
    target: &Path,
) -> AppResult<Option<tempfile::NamedTempFile>> {
    if file_occupied(target) {
        return Ok(None);
    }
    if !source.is_file() {
        tracing::warn!(?source, "audio memo import source is gone");
        return Ok(None);
    }
    let mut temp = tempfile::NamedTempFile::new_in(staging)?;
    std::io::copy(&mut fs::File::open(source)?, temp.as_file_mut())?;
    temp.as_file().sync_all()?; // the persist's own fsync is then cheap
    Ok(Some(temp))
}

/// Persist a staged copy unless a concurrent import took the target first.
fn persist_import(temp: tempfile::NamedTempFile, target: &Path) -> AppResult<()> {
    if file_occupied(target) {
        return Ok(());
    }
    persist_exact(temp, target)
}

impl Core {
    /// Command: start a streamed asset upload: creates a temp file in the
    /// graph's staging dir and returns the upload id for
    /// `asset_upload_append`/`_commit`.
    pub fn asset_upload_begin(&self, generation: u64) -> AppResult<String> {
        // Process-local sequence: ids only need to be unique within this app run
        // (the registry dies with the process), so a counter beats a uuid dep.
        static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);
        let root = root_for_generation(&self.graph, generation)?;
        let file = tempfile::NamedTempFile::new_in(staging_dir(&root)?)?;
        let id = format!("upload-{}", NEXT_UPLOAD_ID.fetch_add(1, Ordering::Relaxed));
        lock_uploads(&self.asset_uploads)?.insert(id.clone(), Upload { generation, file });
        Ok(id)
    }

    /// Command: append one chunk to the in-flight upload `id`.
    pub fn asset_upload_append(&self, id: &str, bytes: &[u8]) -> AppResult<()> {
        let mut uploads = lock_uploads(&self.asset_uploads)?;
        let upload = uploads
            .get_mut(id)
            .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
        upload.file.as_file_mut().write_all(bytes)?;
        Ok(())
    }

    /// Command: finish a streamed upload: fsync, then move the staged file
    /// into `assets/` under `desired_name` (or the first free `-2`-suffixed
    /// variant). Returns the final graph-relative `assets/…` path.
    pub fn asset_upload_commit(
        &self,
        id: String,
        desired_name: String,
        generation: u64,
    ) -> AppResult<String> {
        let upload = lock_uploads(&self.asset_uploads)?
            .remove(&id)
            .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
        if upload.generation != generation {
            return Err(AppError::io(
                "upload was started for a different graph session; dropping it",
            ));
        }
        // Pin the root before persisting: after the file lands, a failed root
        // lookup would otherwise skip invalidation and strand a stale catalog.
        let root = root_for_generation(&self.graph, generation)?;
        let final_name = with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            let assets_dir = assets_dir_for(&root, &desired_name)?;
            persist_unique(upload.file, &assets_dir, &desired_name)
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(format!("assets/{final_name}"))
    }

    /// Command: finish a streamed upload at an **exact graph-relative path** —
    /// the audio memo intake, where `audio-memos/<base>.<ext>` *is* the memo's
    /// identity (its transcription note and daily-note backlink share the
    /// basename), so the `assets/` collision renaming of
    /// [`Core::asset_upload_commit`] would corrupt it. Memo basenames carry
    /// millisecond precision; an existing file at `path` is a bug and fails
    /// loudly rather than being clobbered.
    pub fn asset_upload_commit_path(
        &self,
        id: String,
        path: String,
        generation: u64,
    ) -> AppResult<()> {
        let upload = lock_uploads(&self.asset_uploads)?
            .remove(&id)
            .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
        if upload.generation != generation {
            return Err(AppError::io(
                "upload was started for a different graph session; dropping it",
            ));
        }
        let root = root_for_generation(&self.graph, generation)?;
        with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            let target = resolve(&root, &path)?;
            persist_exact(upload.file, &target)
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(())
    }

    /// Command: discard an in-flight upload; dropping the temp file deletes
    /// it. Idempotent — aborting an unknown id (already committed, or lost to
    /// a restart) is fine.
    pub fn asset_upload_abort(&self, id: String) -> AppResult<()> {
        lock_uploads(&self.asset_uploads)?.remove(&id);
        Ok(())
    }

    /// Command: copy a file the OS gave us a real path for (file picker) into
    /// `assets/` under `desired_name`, with the same collision policy as
    /// uploads. The bytes never cross the IPC. Returns the final
    /// graph-relative `assets/…` path.
    pub async fn asset_import(
        &self,
        source_path: String,
        desired_name: String,
        generation: u64,
    ) -> AppResult<String> {
        if !Path::new(&source_path).is_file() {
            return Err(AppError::not_found(format!(
                "import source is not a file: {source_path}"
            )));
        }
        let root = root_for_generation(&self.graph, generation)?;
        let staging = staging_dir(&root)?;
        let temp = self
            .spawn_blocking(move || {
                let mut temp = tempfile::NamedTempFile::new_in(staging)?;
                std::io::copy(&mut fs::File::open(&source_path)?, temp.as_file_mut())?;
                temp.as_file().sync_all()?; // the persist's own fsync is then cheap
                Ok(temp)
            })
            .await?;
        let final_name = with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            let assets_dir = assets_dir_for(&root, &desired_name)?;
            persist_unique(temp, &assets_dir, &desired_name)
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(format!("assets/{final_name}"))
    }

    /// Command: copy a recording the OS gave us a real path for (the iOS
    /// recorder's staging directory) into `audio-memos/` at an exact path. The
    /// bytes never enter webview memory, which is what makes meeting-length
    /// segments affordable on a phone. The destination is fenced to
    /// `audio-memos/` like `audio_memo_delete`, and the path *is* the memo's
    /// identity, so the `assets/` collision renaming of [`Core::asset_import`]
    /// would corrupt it.
    pub async fn audio_memo_import(
        &self,
        source_path: String,
        path: String,
        generation: u64,
    ) -> AppResult<()> {
        if !path.starts_with("audio-memos/") {
            return Err(AppError::traversal(format!(
                "not an audio memo path: {path}"
            )));
        }
        let root = root_for_generation(&self.graph, generation)?;
        let staging = staging_dir(&root)?;
        let target = resolve(&root, &path)?;
        let staged = self
            .spawn_blocking(move || stage_import(Path::new(&source_path), &staging, &target))
            .await?;
        if let Some(temp) = staged {
            with_graph_lock(&root, || {
                root_for_generation(&self.graph, generation)?;
                persist_import(temp, &resolve(&root, &path)?)
            })?;
        }
        invalidate_file_catalog(&self.graph, &root);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reflect_graph_io::io::bootstrap;
    use tempfile::tempdir;

    fn temp_in(dir: &Path, contents: &[u8]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new_in(dir).unwrap();
        file.write_all(contents).unwrap();
        file
    }

    #[test]
    fn asset_names_must_be_plain_filenames() {
        assert!(ensure_asset_name("report.pdf").is_ok());
        assert!(ensure_asset_name(".hidden").is_ok());
        assert!(ensure_asset_name("").is_err());
        assert!(ensure_asset_name("a/b.pdf").is_err());
        assert!(ensure_asset_name("a\\b.pdf").is_err());
        assert!(ensure_asset_name(".").is_err());
        assert!(ensure_asset_name("..").is_err());
    }

    #[test]
    fn split_keeps_extension_and_treats_leading_dot_as_stem() {
        assert_eq!(split_name("report.pdf"), ("report", ".pdf"));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_name("README"), ("README", ""));
        assert_eq!(split_name(".gitignore"), (".gitignore", ""));
    }

    #[test]
    fn persist_takes_the_desired_name_when_free() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        let temp = temp_in(graph.path(), b"pdf bytes");
        let name = persist_unique(temp, &assets, "report.pdf").unwrap();
        assert_eq!(name, "report.pdf");
        assert_eq!(fs::read(assets.join("report.pdf")).unwrap(), b"pdf bytes");
    }

    #[test]
    fn persist_probes_numbered_suffixes_on_collision() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        fs::write(assets.join("report.pdf"), b"first").unwrap();
        fs::write(assets.join("report-2.pdf"), b"second").unwrap();
        let temp = temp_in(graph.path(), b"third");
        let name = persist_unique(temp, &assets, "report.pdf").unwrap();
        assert_eq!(name, "report-3.pdf");
        // Nothing existing was touched.
        assert_eq!(fs::read(assets.join("report.pdf")).unwrap(), b"first");
        assert_eq!(fs::read(assets.join("report-2.pdf")).unwrap(), b"second");
    }

    #[test]
    fn persist_suffixes_extensionless_names() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        fs::write(assets.join("README"), b"first").unwrap();
        let temp = temp_in(graph.path(), b"second");
        assert_eq!(persist_unique(temp, &assets, "README").unwrap(), "README-2");
    }

    #[test]
    fn persist_exact_creates_parents_and_writes_the_target() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let temp = temp_in(graph.path(), b"opus bytes");
        let target = graph
            .path()
            .join("audio-memos/audio-memo-2026-07-19-090000-000.m4a");
        persist_exact(temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"opus bytes");
    }

    #[test]
    fn persist_exact_never_clobbers_an_existing_file() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.m4a");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"first").unwrap();
        let temp = temp_in(graph.path(), b"second");
        assert!(persist_exact(temp, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first");
    }

    #[test]
    fn import_copies_the_source_to_the_exact_target() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let source = temp_in(graph.path(), b"segment bytes");
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        import_exact(source.path(), &staging_dir(graph.path()).unwrap(), &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"segment bytes");
    }

    #[test]
    fn import_skips_a_source_that_is_already_gone() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        import_exact(
            &graph.path().join("staging/vanished.m4a"),
            &staging_dir(graph.path()).unwrap(),
            &target,
        )
        .unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn import_leaves_an_existing_target_alone() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"already landed").unwrap();
        let source = temp_in(graph.path(), b"second copy");
        import_exact(source.path(), &staging_dir(graph.path()).unwrap(), &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"already landed");
    }

    #[test]
    fn dispatch_routes_raw_upload_chunks_and_binary_reads() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let core = crate::test_support::core();
        let generation = 1;
        {
            let mut inner = core.graph.0.lock().unwrap();
            inner.generation = generation;
            inner.root = Some(graph.path().to_path_buf());
        }
        core.runtime.block_on(async {
            let args = format!(r#"{{"generation":{generation}}}"#);
            let crate::Reply::Json(id) = core
                .dispatch("asset_upload_begin", args.as_bytes(), b"{}", None)
                .await
                .unwrap()
            else {
                panic!("expected a JSON reply");
            };
            let id: String = serde_json::from_str(&id).unwrap();
            let headers = format!(r#"{{"{UPLOAD_ID_HEADER}":"{id}"}}"#);
            for chunk in [&b"cat "[..], &b"bytes"[..]] {
                core.dispatch(
                    "asset_upload_append",
                    b"{}",
                    headers.as_bytes(),
                    Some(chunk),
                )
                .await
                .unwrap();
            }
            let error = core
                .dispatch("asset_upload_append", b"{}", b"{}", Some(b"x"))
                .await
                .unwrap_err();
            assert!(error.message().contains(UPLOAD_ID_HEADER), "{error:?}");
            let args =
                format!(r#"{{"id":"{id}","desiredName":"cat.png","generation":{generation}}}"#);
            core.dispatch("asset_upload_commit", args.as_bytes(), b"{}", None)
                .await
                .unwrap();
            let args = format!(r#"{{"path":"assets/cat.png","generation":{generation}}}"#);
            assert_eq!(
                core.dispatch("asset_read_binary", args.as_bytes(), b"{}", None)
                    .await
                    .unwrap(),
                crate::Reply::Bytes(b"cat bytes".to_vec())
            );
        });
    }

    #[test]
    fn staging_dir_lives_under_reflect() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let dir = staging_dir(graph.path()).unwrap();
        assert!(dir.starts_with(graph.path().join(".reflect")));
        assert!(dir.is_dir());
    }
}
