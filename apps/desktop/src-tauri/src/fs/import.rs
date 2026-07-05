//! Reflect V1 export import.
//!
//! Reflect V1 now exports the same markdown graph layout Reflect Open reads:
//! `daily/`, `notes/`, optional `assets/`, plus ignorable local metadata. The
//! import path is therefore a bounded archive extraction into the active graph,
//! not a content migration.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::io::{atomic_write_bytes, file_occupied};
use super::resolve::resolve;

/// Summary returned to the settings UI after an import completes.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Files newly written to the open graph.
    pub imported_files: usize,
    /// Files already present with identical bytes, left untouched.
    pub skipped_files: usize,
    /// Graph-relative paths newly written to the open graph.
    pub changed_paths: Vec<String>,
}

struct ImportEntry {
    relative: String,
    bytes: Vec<u8>,
}

/// Import a user-selected Reflect V1 export zip into `root`.
pub(super) fn import_zip_into_graph(root: &Path, zip_path: &Path) -> AppResult<ImportSummary> {
    let entries = read_zip_entries(zip_path)?;
    import_entries_into_graph(root, entries)
}

fn import_entries_into_graph(root: &Path, entries: Vec<ImportEntry>) -> AppResult<ImportSummary> {
    let entries = dedupe_entries(entries)?;
    if !entries
        .iter()
        .any(|entry| is_note_markdown(&entry.relative))
    {
        return Err(AppError::not_found(
            "that doesn't look like a Reflect V1 export — no notes found under daily/ or notes/",
        ));
    }

    let collisions = entries
        .iter()
        .map(|entry| collision(root, entry))
        .collect::<AppResult<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !collisions.is_empty() {
        return Err(AppError::io(format!(
            "import would overwrite existing files: {}",
            collisions
                .iter()
                .take(5)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    let mut imported_files = 0;
    let mut skipped_files = 0;
    let mut changed_paths = Vec::new();
    for entry in entries {
        let target = resolve(root, &entry.relative)?;
        if let Some(path) = collision(root, &entry)? {
            return Err(AppError::io(format!(
                "import would overwrite existing files: {path}"
            )));
        }
        if target.is_file() && fs::read(&target)? == entry.bytes {
            skipped_files += 1;
            continue;
        }
        atomic_write_bytes(root, &target, &entry.bytes)?;
        imported_files += 1;
        changed_paths.push(entry.relative);
    }

    Ok(ImportSummary {
        imported_files,
        skipped_files,
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

fn collision(root: &Path, entry: &ImportEntry) -> AppResult<Option<String>> {
    let target = resolve(root, &entry.relative)?;
    if !target.exists() && !file_occupied(&target) {
        return Ok(None);
    }
    if target.is_file() && fs::read(&target)? == entry.bytes {
        return Ok(None);
    }
    Ok(Some(entry.relative.clone()))
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
    use std::io::Write;
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
                changed_paths: vec![
                    "notes/a.md".to_string(),
                    "daily/2026-07-04.md".to_string(),
                    "assets/pic.bin".to_string()
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

    #[test]
    fn refuses_to_overwrite_existing_files() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")]));

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("notes/a.md")),
            other => panic!("expected an IO collision error, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Mine\n"
        );
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

    #[test]
    fn evicted_icloud_placeholder_blocks_import() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/.a.md.icloud"), "placeholder").unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")]));

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("notes/a.md")),
            other => panic!("expected a placeholder collision error, got {other:?}"),
        }
        assert!(!root.path().join("notes/a.md").exists());
        assert!(root.path().join("notes/.a.md.icloud").exists());
    }

    #[test]
    fn rejects_archives_without_notes() {
        let root = tempdir().unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("assets/pic.bin", "raw")]));

        assert!(result.is_err());
        assert!(!root.path().join("assets/pic.bin").exists());
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
