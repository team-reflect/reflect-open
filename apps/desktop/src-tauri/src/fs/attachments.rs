//! Safe resolution for local attachments referenced by note Markdown.
//!
//! The frontend sends the authored reference plus its source note. This module
//! turns that into a canonical graph-relative path without ever exposing an
//! absolute filesystem path over IPC. Every consumer revalidates the resolved
//! path because protocol URLs and open commands are independently forgeable.

use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SUPPORTED_EXTENSIONS: [&str; 20] = [
    "3gp", "avif", "bmp", "flac", "gif", "jpeg", "jpg", "m4a", "mkv", "mov", "mp3", "mp4", "ogg",
    "ogv", "pdf", "png", "svg", "wav", "webm", "webp",
];
const IMAGE_EXTENSIONS: [&str; 8] = ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

/// The authored syntax determines whether an unqualified filename is a
/// source-relative Markdown URL or an Obsidian-style vault lookup.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentReferenceKind {
    Markdown,
    WikiEmbed,
}

/// IPC request for resolving one local attachment reference.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentResolveRequest {
    pub source_path: String,
    pub reference: String,
    pub reference_kind: AttachmentReferenceKind,
    pub generation: u64,
}

/// Whether a resolved attachment is safe to render inline or should be shown
/// as a file that opens in its registered OS application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentRenderKind {
    Image,
    File,
}

/// Resolution is deliberately explicit at the IPC boundary. In particular,
/// absence and ambiguity never collapse into a guessed filesystem path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum AttachmentResolveOutcome {
    Resolved {
        path: String,
        render_kind: AttachmentRenderKind,
    },
    NotFound,
    /// The path exists as an iCloud placeholder but cannot be read yet.
    Unavailable {
        path: String,
    },
    /// More than one safe candidate matched; no candidate was selected.
    Ambiguous {
        paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidatePresence {
    Available,
    Unavailable,
    Missing,
}

/// Resolve an attachment reference against a graph root.
pub(super) fn resolve_reference(
    root: &Path,
    source_path: &str,
    reference: &str,
    reference_kind: AttachmentReferenceKind,
) -> AppResult<AttachmentResolveOutcome> {
    let source_components = visible_wire_components(source_path)?;
    if !source_path.ends_with(".md") {
        return Err(AppError::parse(format!(
            "attachment source is not a Markdown note: {source_path}"
        )));
    }
    let source_dir = &source_components[..source_components.len().saturating_sub(1)];
    let decoded = decode_reference(reference)?;

    match reference_kind {
        AttachmentReferenceKind::Markdown => resolve_markdown(root, source_dir, &decoded),
        AttachmentReferenceKind::WikiEmbed => resolve_wiki_embed(root, &decoded),
    }
}

fn resolve_markdown(
    root: &Path,
    source_dir: &[String],
    reference: &str,
) -> AppResult<AttachmentResolveOutcome> {
    if reference.starts_with('/') {
        let path = normalize_reference(&[], explicit_vault_reference(reference)?)?;
        return outcome_for_path(root, &path);
    }
    if reference.starts_with("./") || reference.starts_with("../") {
        let path = normalize_reference(source_dir, reference)?;
        return outcome_for_path(root, &path);
    }

    let source_relative = normalize_reference(source_dir, reference)?;
    let vault_relative = normalize_reference(&[], reference)?;
    if source_relative == vault_relative {
        return outcome_for_path(root, &source_relative);
    }

    let source_presence = candidate_presence(root, &source_relative)?;
    let vault_presence = candidate_presence(root, &vault_relative)?;
    outcome_for_candidates([
        (source_relative, source_presence),
        (vault_relative, vault_presence),
    ])
}

fn resolve_wiki_embed(root: &Path, reference: &str) -> AppResult<AttachmentResolveOutcome> {
    if reference.contains('/') {
        let reference = if reference.starts_with('/') {
            explicit_vault_reference(reference)?
        } else {
            reference
        };
        let path = normalize_reference(&[], reference)?;
        return outcome_for_path(root, &path);
    }
    ensure_supported_file_name(reference)?;
    let candidates = find_unique_filename_candidates(root, reference)?;
    outcome_for_candidates(candidates)
}

fn explicit_vault_reference(reference: &str) -> AppResult<&str> {
    let relative = reference.strip_prefix('/').ok_or_else(|| {
        AppError::traversal(format!(
            "expected a vault-root attachment path: {reference}"
        ))
    })?;
    if relative.starts_with('/') || relative.is_empty() {
        return Err(AppError::traversal(format!(
            "invalid vault-root attachment path: {reference}"
        )));
    }
    Ok(relative)
}

fn outcome_for_path(root: &Path, path: &str) -> AppResult<AttachmentResolveOutcome> {
    let presence = candidate_presence(root, path)?;
    outcome_for_candidates([(path.to_string(), presence)])
}

fn outcome_for_candidates(
    candidates: impl IntoIterator<Item = (String, CandidatePresence)>,
) -> AppResult<AttachmentResolveOutcome> {
    let mut matches: Vec<(String, CandidatePresence)> = candidates
        .into_iter()
        .filter(|(_, presence)| *presence != CandidatePresence::Missing)
        .collect();
    matches.sort_by(|left, right| left.0.cmp(&right.0));
    matches.dedup_by(|left, right| left.0 == right.0);

    match matches.as_slice() {
        [] => Ok(AttachmentResolveOutcome::NotFound),
        [(path, CandidatePresence::Available)] => Ok(AttachmentResolveOutcome::Resolved {
            path: path.clone(),
            render_kind: render_kind(path),
        }),
        [(path, CandidatePresence::Unavailable)] => {
            Ok(AttachmentResolveOutcome::Unavailable { path: path.clone() })
        }
        [(_, CandidatePresence::Missing)] => unreachable!("missing candidates were filtered"),
        _ => Ok(AttachmentResolveOutcome::Ambiguous {
            paths: matches.into_iter().map(|(path, _)| path).collect(),
        }),
    }
}

fn decode_reference(reference: &str) -> AppResult<String> {
    let path = reference
        .split_once('#')
        .map_or(reference, |(path, _)| path);
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    if path.is_empty() {
        return Err(AppError::parse("attachment reference has no path"));
    }
    percent_decode_str(path)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|err| AppError::parse(format!("attachment path is not valid UTF-8: {err}")))
}

fn visible_wire_components(path: &str) -> AppResult<Vec<String>> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\0')
        || path.contains('\\')
    {
        return Err(AppError::traversal(format!(
            "attachment path is not a visible graph-relative path: {path}"
        )));
    }
    let components: Vec<String> = path.split('/').map(str::to_string).collect();
    if components
        .iter()
        .any(|component| component.is_empty() || component.starts_with('.'))
        || components
            .first()
            .is_some_and(|first| first.len() == 2 && first.ends_with(':'))
    {
        return Err(AppError::traversal(format!(
            "attachment path is not a visible graph-relative path: {path}"
        )));
    }
    Ok(components)
}

fn normalize_reference(base: &[String], reference: &str) -> AppResult<String> {
    if reference.is_empty() || reference.contains('\0') || reference.contains('\\') {
        return Err(AppError::traversal(format!(
            "invalid local attachment path: {reference}"
        )));
    }
    let mut components = base.to_vec();
    for component in reference.split('/') {
        match component {
            "" => {
                return Err(AppError::traversal(format!(
                    "invalid local attachment path: {reference}"
                )))
            }
            "." => {}
            ".." => {
                if components.pop().is_none() {
                    return Err(AppError::traversal(format!(
                        "attachment path escapes the graph: {reference}"
                    )));
                }
            }
            component if component.starts_with('.') => {
                return Err(AppError::traversal(format!(
                    "hidden attachment paths are not allowed: {reference}"
                )))
            }
            component => components.push(component.to_string()),
        }
    }
    let normalized = components.join("/");
    visible_wire_components(&normalized)?;
    ensure_supported_path(&normalized)?;
    Ok(normalized)
}

/// Validate an already resolved protocol/open path without consulting authored
/// reference semantics.
pub(super) fn ensure_supported_path(path: &str) -> AppResult<()> {
    visible_wire_components(path)?;
    let file_name = path
        .rsplit('/')
        .next()
        .ok_or_else(|| AppError::parse("attachment path has no filename"))?;
    ensure_supported_file_name(file_name)
}

fn ensure_supported_file_name(file_name: &str) -> AppResult<()> {
    let extension = file_name.rsplit_once('.').map(|(_, extension)| extension);
    if extension.is_some_and(|extension| {
        SUPPORTED_EXTENSIONS
            .iter()
            .any(|supported| extension.eq_ignore_ascii_case(supported))
    }) {
        return Ok(());
    }
    Err(AppError::parse(format!(
        "unsupported local attachment format: {file_name}"
    )))
}

fn render_kind(path: &str) -> AttachmentRenderKind {
    let extension = path.rsplit_once('.').map_or("", |(_, extension)| extension);
    if IMAGE_EXTENSIONS
        .iter()
        .any(|supported| extension.eq_ignore_ascii_case(supported))
    {
        AttachmentRenderKind::Image
    } else {
        AttachmentRenderKind::File
    }
}

fn candidate_presence(root: &Path, path: &str) -> AppResult<CandidatePresence> {
    ensure_supported_path(path)?;
    let absolute = super::resolve::resolve(root, path)?;
    reject_symlink_components(root, &absolute)?;

    match fs::symlink_metadata(&absolute) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::traversal(format!(
            "attachment path contains a symlink: {path}"
        ))),
        Ok(metadata) if metadata.is_file() => Ok(CandidatePresence::Available),
        Ok(_) => Ok(CandidatePresence::Missing),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let Some(placeholder) = placeholder_for(&absolute) else {
                return Ok(CandidatePresence::Missing);
            };
            match fs::symlink_metadata(&placeholder) {
                Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::traversal(
                    format!("attachment placeholder is a symlink: {path}"),
                )),
                Ok(metadata) if metadata.is_file() => Ok(CandidatePresence::Unavailable),
                Ok(_) => Ok(CandidatePresence::Missing),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    Ok(CandidatePresence::Missing)
                }
                Err(err) => Err(err.into()),
            }
        }
        Err(err) => Err(err.into()),
    }
}

/// Resolve a path supplied directly to the protocol or OS opener and verify
/// that every existing component is a real directory/file, never a symlink.
pub(super) fn resolve_existing_path(root: &Path, path: &str) -> AppResult<PathBuf> {
    match candidate_presence(root, path)? {
        CandidatePresence::Available => super::resolve::resolve(root, path),
        CandidatePresence::Unavailable => Err(AppError::not_found(format!(
            "attachment is not available on this device: {path}"
        ))),
        CandidatePresence::Missing => {
            Err(AppError::not_found(format!("attachment not found: {path}")))
        }
    }
}

fn reject_symlink_components(root: &Path, path: &Path) -> AppResult<()> {
    let relative = path.strip_prefix(root).map_err(|_| {
        AppError::traversal(format!(
            "attachment path escapes the graph: {}",
            path.display()
        ))
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::traversal(format!(
                    "attachment path contains a symlink: {}",
                    relative.display()
                )))
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn placeholder_for(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.with_file_name(format!(".{name}.icloud")))
}

/// Best-effort iCloud materialization for an explicitly resolved placeholder.
/// Resolution still returns `unavailable`; the watcher causes the frontend to
/// retry after the operating system replaces the stub with the real file.
pub(super) fn request_materialization(root: &Path, path: &str) {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        let absolute = root.join(path);
        if let Some(placeholder) = placeholder_for(&absolute) {
            crate::icloud::storage::request_download(&placeholder);
        }
        crate::icloud::storage::request_download(&absolute);
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let _ = (root, path);
    }
}

fn find_unique_filename_candidates(
    root: &Path,
    requested_name: &str,
) -> AppResult<Vec<(String, CandidatePresence)>> {
    let mut candidates = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                let logical_match = icloud_placeholder_target(name)
                    .is_some_and(|target| target.eq_ignore_ascii_case(requested_name));
                if name.eq_ignore_ascii_case(requested_name) || logical_match {
                    return Err(AppError::traversal(format!(
                        "attachment filename matches a symlink: {requested_name}"
                    )));
                }
                continue;
            }
            if file_type.is_dir() {
                if !name.starts_with('.') {
                    stack.push(entry.path());
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            if let Some(logical_name) = icloud_placeholder_target(name) {
                if !logical_name.starts_with('.')
                    && logical_name.eq_ignore_ascii_case(requested_name)
                    && ensure_supported_file_name(logical_name).is_ok()
                {
                    let logical_path = entry.path().with_file_name(logical_name);
                    if !logical_path.exists() {
                        candidates.push((
                            graph_relative_string(root, &logical_path)?,
                            CandidatePresence::Unavailable,
                        ));
                    }
                }
                continue;
            }
            if name.starts_with('.')
                || !name.eq_ignore_ascii_case(requested_name)
                || ensure_supported_file_name(name).is_err()
            {
                continue;
            }
            candidates.push((
                graph_relative_string(root, &entry.path())?,
                CandidatePresence::Available,
            ));
        }
    }
    Ok(candidates)
}

fn graph_relative_string(root: &Path, path: &Path) -> AppResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        AppError::traversal(format!(
            "attachment path escapes the graph: {}",
            path.display()
        ))
    })?;
    let path = relative.to_str().ok_or_else(|| {
        AppError::parse(format!(
            "attachment path is not valid UTF-8: {}",
            relative.display()
        ))
    })?;
    let path = path.replace('\\', "/");
    ensure_supported_path(&path)?;
    Ok(path)
}

fn icloud_placeholder_target(name: &str) -> Option<&str> {
    let target = name.strip_prefix('.')?.strip_suffix(".icloud")?;
    (!target.is_empty()).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"content").unwrap();
    }

    #[test]
    fn resolves_relative_explicit_and_url_decoded_markdown_paths() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Projects/Plan.md");
        write(graph.path(), "Projects/images/local.png");
        write(graph.path(), "Shared/photo one.JPG");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Projects/Plan.md",
                "./images/local.png",
                AttachmentReferenceKind::Markdown,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "Projects/images/local.png".into(),
                render_kind: AttachmentRenderKind::Image,
            }
        );
        assert_eq!(
            resolve_reference(
                graph.path(),
                "Projects/Plan.md",
                "/Shared/photo%20one.JPG#preview",
                AttachmentReferenceKind::Markdown,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "Shared/photo one.JPG".into(),
                render_kind: AttachmentRenderKind::Image,
            }
        );
    }

    #[test]
    fn preserves_legacy_vault_relative_assets_links() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "notes/Plan.md");
        write(graph.path(), "assets/photo.png");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "notes/Plan.md",
                "assets/photo.png",
                AttachmentReferenceKind::Markdown,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "assets/photo.png".into(),
                render_kind: AttachmentRenderKind::Image,
            }
        );
    }

    #[test]
    fn markdown_root_and_source_relative_collision_is_ambiguous() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Projects/Plan.md");
        write(graph.path(), "Projects/photo.png");
        write(graph.path(), "photo.png");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Projects/Plan.md",
                "photo.png",
                AttachmentReferenceKind::Markdown,
            )
            .unwrap(),
            AttachmentResolveOutcome::Ambiguous {
                paths: vec!["Projects/photo.png".into(), "photo.png".into()],
            }
        );
    }

    #[test]
    fn wiki_embed_uses_unique_filename_and_rejects_duplicates() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Plan.md");
        write(graph.path(), "Media/photo.png");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Plan.md",
                "photo.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "Media/photo.png".into(),
                render_kind: AttachmentRenderKind::Image,
            }
        );

        write(graph.path(), "Other/PHOTO.PNG");
        assert_eq!(
            resolve_reference(
                graph.path(),
                "Plan.md",
                "photo.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::Ambiguous {
                paths: vec!["Media/photo.png".into(), "Other/PHOTO.PNG".into()],
            }
        );
    }

    #[test]
    fn wiki_path_is_vault_relative_and_non_images_are_files() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Nested/Plan.md");
        write(graph.path(), "Media/manual.pdf");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Nested/Plan.md",
                "Media/manual.pdf",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "Media/manual.pdf".into(),
                render_kind: AttachmentRenderKind::File,
            }
        );
    }

    #[test]
    fn missing_and_icloud_placeholder_are_distinct() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Plan.md");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Plan.md",
                "missing.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::NotFound
        );

        write(graph.path(), "Media/.remote.png.icloud");
        assert_eq!(
            resolve_reference(
                graph.path(),
                "Plan.md",
                "remote.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::Unavailable {
                path: "Media/remote.png".into(),
            }
        );
    }

    #[test]
    fn rejects_traversal_hidden_paths_and_unsupported_formats() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Nested/Plan.md");

        for reference in [
            "../../outside.png",
            "%2e%2e/%2e%2e/outside.png",
            "../.hidden.png",
            "folder\\photo.png",
            "//server/photo.png",
        ] {
            let error = resolve_reference(
                graph.path(),
                "Nested/Plan.md",
                reference,
                AttachmentReferenceKind::Markdown,
            )
            .unwrap_err();
            assert!(matches!(error, AppError::Traversal { .. }), "{reference}");
        }

        let error = resolve_reference(
            graph.path(),
            "Nested/Plan.md",
            "payload.html",
            AttachmentReferenceKind::Markdown,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::Parse { .. }));
    }

    #[test]
    fn accepts_the_supported_obsidian_extension_set_case_insensitively() {
        for extension in SUPPORTED_EXTENSIONS {
            assert!(
                ensure_supported_path(&format!("Media/file.{}", extension.to_uppercase())).is_ok(),
                "{extension}"
            );
        }
        for path in [
            "Media/file",
            "Media/file.md",
            "Media/file.html",
            ".file.png",
        ] {
            assert!(ensure_supported_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn unique_filename_lookup_prunes_hidden_trees() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Plan.md");
        write(graph.path(), ".obsidian/photo.png");
        write(graph.path(), "Visible/photo.png");

        assert_eq!(
            resolve_reference(
                graph.path(),
                "Plan.md",
                "photo.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::Resolved {
                path: "Visible/photo.png".into(),
                render_kind: AttachmentRenderKind::Image,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_direct_and_unique_filename_symlinks() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Plan.md");
        write(graph.path(), "real.png");
        fs::create_dir_all(graph.path().join("Media")).unwrap();
        symlink(
            graph.path().join("real.png"),
            graph.path().join("Media/link.png"),
        )
        .unwrap();

        for kind in [
            AttachmentReferenceKind::Markdown,
            AttachmentReferenceKind::WikiEmbed,
        ] {
            let error =
                resolve_reference(graph.path(), "Plan.md", "Media/link.png", kind).unwrap_err();
            assert!(matches!(error, AppError::Traversal { .. }));
        }
        let error = resolve_reference(
            graph.path(),
            "Plan.md",
            "link.png",
            AttachmentReferenceKind::WikiEmbed,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::Traversal { .. }));

        symlink(
            graph.path().join("real.png"),
            graph.path().join("Media/.remote.png.icloud"),
        )
        .unwrap();
        let error = resolve_reference(
            graph.path(),
            "Plan.md",
            "remote.png",
            AttachmentReferenceKind::WikiEmbed,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::Traversal { .. }));
    }

    #[test]
    fn outcome_serializes_as_a_zod_friendly_discriminated_union() {
        assert_eq!(
            serde_json::to_value(AttachmentResolveOutcome::Resolved {
                path: "Media/photo.png".into(),
                render_kind: AttachmentRenderKind::Image,
            })
            .unwrap(),
            json!({
                "kind": "resolved",
                "path": "Media/photo.png",
                "renderKind": "image",
            })
        );
        assert_eq!(
            serde_json::to_value(AttachmentResolveOutcome::NotFound).unwrap(),
            json!({ "kind": "notFound" })
        );
    }
}
