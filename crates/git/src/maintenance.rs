//! Object database maintenance: the repack that `git gc --auto` would run.
//!
//! libgit2 has no `gc`. Every commit writes loose objects (one zlib file per
//! object, no deltas) and every fetch keeps its pack as received, so a
//! long-used repository holds thousands of loose objects and hundreds of
//! packs. Each object write then searches every pack index, and a revwalk
//! keeps one file descriptor per pack open.
//!
//! [`maintain`] checks the same cheap thresholds as `git gc --auto` and, when
//! one is crossed, writes every object into one new pack and removes the
//! packs and loose objects that the new pack holds. It never decides
//! reachability, so it never removes an object that is not in the new pack.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Duration;

use git2::Oid;
use reflect_types::AppResult;

use super::repo::open_existing;

/// The open pack files libgit2 may keep at once. Above it, libgit2 closes the
/// least recently used one. iOS gives an app 256 file descriptors.
const MWINDOW_FILE_LIMIT: usize = 64;

/// `gc.auto`: repack at about 6700 loose objects, estimated from one of the
/// 256 fan-out directories.
const LOOSE_OBJECT_LIMIT: usize = 6700;
const LOOSE_SAMPLE_DIR: &str = "17";

/// `gc.autoPackLimit`: repack above this many packs.
const PACK_LIMIT: usize = 50;

/// libgit2 writes a pack to `pack/pack_git2_XXXXXX` and renames it when it is
/// complete. A process killed in between leaves the temp file behind.
const TEMP_PACK_PREFIX: &str = "pack_git2_";
/// Older temp packs belong to no running write.
const TEMP_PACK_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Files that belong to a pack, removed with it. `.idx` goes first, so
/// libgit2 stops listing the pack before its data disappears.
const PACK_EXTENSIONS: [&str; 5] = ["idx", "pack", "rev", "bitmap", "mtimes"];

/// What a repack did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Repack {
    pub objects: usize,
    pub removed_packs: usize,
    pub removed_loose_objects: usize,
}

/// Bound the pack files libgit2 keeps open (see [`MWINDOW_FILE_LIMIT`]).
/// Runs once per process, before the first repository is opened.
pub fn configure_libgit2() {
    static CONFIGURE: Once = Once::new();
    CONFIGURE.call_once(|| {
        // SAFETY: libgit2 options are unsynchronized globals. `Once` makes
        // this the only write, and callers run it before any git command.
        if let Err(err) = unsafe { git2::opts::set_mwindow_file_limit(MWINDOW_FILE_LIMIT) } {
            tracing::warn!(%err, "failed to limit libgit2's open pack files");
        }
    });
}

/// Repack the repository when it has too many loose objects or packs.
/// Returns `None` below both thresholds.
///
/// The pack is written outside the graph lock, so note writes and commits go
/// on meanwhile: objects they add are not in the snapshot and stay. Only the
/// removal takes the lock. Run it between git commands, not during a fetch or
/// push: those read packs without the lock.
pub fn maintain(root: &Path) -> AppResult<Option<Repack>> {
    let objects = open_existing(root)?.path().join("objects");
    if !needs_repack(&objects) {
        return Ok(None);
    }
    repack(root).map(Some)
}

fn needs_repack(objects: &Path) -> bool {
    let loose = count_entries(&objects.join(LOOSE_SAMPLE_DIR), |_| true);
    let packs = count_entries(&objects.join("pack"), |path| {
        path.extension().is_some_and(|ext| ext == "pack")
    });
    loose > LOOSE_OBJECT_LIMIT.div_ceil(256) || packs > PACK_LIMIT
}

fn count_entries(dir: &Path, keep: impl Fn(&Path) -> bool) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| keep(&entry.path()))
        .count()
}

/// Write every object into one new pack, then remove what it replaces.
pub(super) fn repack(root: &Path) -> AppResult<Repack> {
    let repo = open_existing(root)?;
    let objects = repo.path().join("objects");
    let pack_dir = objects.join("pack");

    // Snapshot the packs before the objects: every object of a listed pack
    // is then in `ids`, and a pack a fetch adds later is kept.
    let old_packs = removable_packs(&pack_dir)?;
    let mut ids = Vec::new();
    repo.odb()?.foreach(|id| {
        ids.push(*id);
        true
    })?;
    if ids.is_empty() {
        return Ok(Repack::default());
    }

    let mut builder = repo.packbuilder()?;
    // Walk the history first: object paths give better delta bases.
    let mut walk = repo.revwalk()?;
    walk.push_glob("refs/*")?;
    if repo.head().is_ok() {
        walk.push_head()?;
    }
    builder.insert_walk(&mut walk)?;
    // Then every other object (unreachable, staged, reflog-only): the new
    // pack must hold all of `ids`. Inserting an id twice is a no-op.
    for id in &ids {
        builder.insert_object(*id, None)?;
    }
    builder.write(&pack_dir, 0)?;
    let new_pack = builder.name()?.map(|name| format!("pack-{name}"));
    let packed = builder.object_count();
    drop(builder);
    drop(walk);
    drop(repo);

    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeRepackRemove)?;
    let ids: HashSet<Oid> = ids.into_iter().collect();
    reflect_graph_io::with_graph_lock(root, || {
        let mut outcome = Repack {
            objects: packed,
            ..Repack::default()
        };
        for stem in &old_packs {
            if new_pack.as_deref() != stem.file_name().and_then(|name| name.to_str()) {
                remove_pack(stem)?;
                outcome.removed_packs += 1;
            }
        }
        if outcome.removed_packs > 0 {
            // A git CLI index over the removed packs.
            remove_if_exists(&pack_dir.join("multi-pack-index"))?;
        }
        outcome.removed_loose_objects = remove_loose_objects(&objects, &ids)?;
        remove_stale_temp_packs(&pack_dir)?;
        Ok(outcome)
    })
}

/// The packs in `pack_dir` as paths without extension, minus `.keep` packs.
fn removable_packs(pack_dir: &Path) -> AppResult<Vec<PathBuf>> {
    let mut stems = Vec::new();
    let Ok(entries) = fs::read_dir(pack_dir) else {
        return Ok(stems);
    };
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "pack")
            && !path.with_extension("keep").exists()
        {
            stems.push(path.with_extension(""));
        }
    }
    Ok(stems)
}

fn remove_pack(stem: &Path) -> AppResult<()> {
    for ext in PACK_EXTENSIONS {
        remove_if_exists(&stem.with_extension(ext))?;
    }
    Ok(())
}

/// Remove the loose objects whose ids are in `packed`, then the fan-out
/// directories left empty.
fn remove_loose_objects(objects: &Path, packed: &HashSet<Oid>) -> AppResult<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(objects)? {
        let entry = entry?;
        let prefix = entry.file_name().to_string_lossy().into_owned();
        if prefix.len() != 2 || !entry.file_type()?.is_dir() {
            continue;
        }
        for object in fs::read_dir(entry.path())? {
            let object = object?;
            let name = object.file_name().to_string_lossy().into_owned();
            // `Oid::from_str` also takes a short prefix: check the length.
            if name.len() != 38 {
                continue;
            }
            let Ok(id) = Oid::from_str(&format!("{prefix}{name}")) else {
                continue; // a temp file, not an object
            };
            if packed.contains(&id) {
                remove_if_exists(&object.path())?;
                removed += 1;
            }
        }
        // Fails while a new object lives here: keep the directory then.
        let _ = fs::remove_dir(entry.path());
    }
    Ok(removed)
}

fn remove_stale_temp_packs(pack_dir: &Path) -> AppResult<()> {
    for entry in fs::read_dir(pack_dir)? {
        let entry = entry?;
        let stale = entry
            .metadata()?
            .modified()?
            .elapsed()
            .is_ok_and(|age| age > TEMP_PACK_MAX_AGE);
        if stale
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with(TEMP_PACK_PREFIX)
        {
            remove_if_exists(&entry.path())?;
        }
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> AppResult<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}
