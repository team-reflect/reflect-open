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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::error::{AppError, AppResult};

use super::resolve::resolve;
use super::{root_for_generation, GraphState};

/// Header carrying the upload id on `asset_upload_append` calls — raw-body
/// requests have no JSON args, so the id travels out-of-band.
const UPLOAD_ID_HEADER: &str = "x-upload-id";
/// Collision probes before giving up, mirroring `probeNotePath`'s cap.
const MAX_NAME_PROBES: u32 = 1000;

struct Upload {
    generation: u64,
    file: tempfile::NamedTempFile,
}

/// Tauri-managed registry of in-flight streamed uploads, keyed by upload id.
#[derive(Default)]
pub struct AssetUploads(Mutex<HashMap<String, Upload>>);

fn lock_uploads<'locked>(
    uploads: &'locked State<'_, AssetUploads>,
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

/// The staging directory for in-flight uploads: inside the graph (so the
/// commit rename stays on one filesystem) but under `.reflect/` (so the
/// watcher, indexer, and sync never see a partial file).
fn staging_dir(root: &Path) -> AppResult<std::path::PathBuf> {
    let dir = root.join(".reflect").join("tmp");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolved `assets/` directory for a commit/import destination, traversal-
/// and generation-guarded.
fn assets_dir_for(
    state: &State<GraphState>,
    generation: u64,
    name: &str,
) -> AppResult<std::path::PathBuf> {
    ensure_asset_name(name)?;
    let root = root_for_generation(state, generation)?;
    // Resolve the target through the shared guard even though `name` is
    // already vetted — defense in depth, and it canonicalizes symlink games.
    resolve(&root, &format!("assets/{name}"))?;
    let dir = root.join("assets");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Start a streamed asset upload: creates a temp file in the graph's staging
/// dir and returns the upload id for `asset_upload_append`/`_commit`.
#[tauri::command]
pub fn asset_upload_begin(
    generation: u64,
    state: State<GraphState>,
    uploads: State<AssetUploads>,
) -> AppResult<String> {
    // Process-local sequence: ids only need to be unique within this app run
    // (the registry dies with the process), so a counter beats a uuid dep.
    static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);
    let root = root_for_generation(&state, generation)?;
    let file = tempfile::NamedTempFile::new_in(staging_dir(&root)?)?;
    let id = format!("upload-{}", NEXT_UPLOAD_ID.fetch_add(1, Ordering::Relaxed));
    lock_uploads(&uploads)?.insert(id.clone(), Upload { generation, file });
    Ok(id)
}

/// Append one chunk to an in-flight upload. The chunk is the **raw request
/// body** (`InvokeBody::Raw`) — never JSON — and the upload id arrives in the
/// `x-upload-id` header, since a raw-body invoke carries no args.
#[tauri::command]
pub fn asset_upload_append(request: Request<'_>, uploads: State<AssetUploads>) -> AppResult<()> {
    let id = request
        .headers()
        .get(UPLOAD_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::io(format!("missing {UPLOAD_ID_HEADER} header")))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::io(
            "asset_upload_append expects a raw binary body, got JSON",
        ));
    };
    let mut uploads = lock_uploads(&uploads)?;
    let upload = uploads
        .get_mut(id)
        .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
    upload.file.as_file_mut().write_all(bytes)?;
    Ok(())
}

/// Finish a streamed upload: fsync, then move the staged file into `assets/`
/// under `desired_name` (or the first free `-2`-suffixed variant). Returns the
/// final graph-relative `assets/…` path.
#[tauri::command]
pub fn asset_upload_commit(
    id: String,
    desired_name: String,
    generation: u64,
    state: State<GraphState>,
    uploads: State<AssetUploads>,
) -> AppResult<String> {
    let upload = lock_uploads(&uploads)?
        .remove(&id)
        .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
    if upload.generation != generation {
        return Err(AppError::io(
            "upload was started for a different graph session; dropping it",
        ));
    }
    let assets_dir = assets_dir_for(&state, generation, &desired_name)?;
    upload.file.as_file().sync_all()?;
    let final_name = persist_unique(upload.file, &assets_dir, &desired_name)?;
    Ok(format!("assets/{final_name}"))
}

/// Discard an in-flight upload; dropping the temp file deletes it. Idempotent
/// — aborting an unknown id (already committed, or lost to a restart) is fine.
#[tauri::command]
pub fn asset_upload_abort(id: String, uploads: State<AssetUploads>) -> AppResult<()> {
    lock_uploads(&uploads)?.remove(&id);
    Ok(())
}

/// Copy a file the OS gave us a real path for (file picker) into `assets/`
/// under `desired_name`, with the same collision policy as uploads. The bytes
/// never cross the IPC. Returns the final graph-relative `assets/…` path.
#[tauri::command]
pub fn asset_import(
    source_path: String,
    desired_name: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(AppError::not_found(format!(
            "import source is not a file: {source_path}"
        )));
    }
    let root = root_for_generation(&state, generation)?;
    let mut temp = tempfile::NamedTempFile::new_in(staging_dir(&root)?)?;
    std::io::copy(&mut fs::File::open(source)?, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    let assets_dir = assets_dir_for(&state, generation, &desired_name)?;
    let final_name = persist_unique(temp, &assets_dir, &desired_name)?;
    Ok(format!("assets/{final_name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::io::bootstrap;
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
    fn staging_dir_lives_under_reflect() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let dir = staging_dir(graph.path()).unwrap();
        assert!(dir.starts_with(graph.path().join(".reflect")));
        assert!(dir.is_dir());
    }
}
