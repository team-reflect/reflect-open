//! Safe resolution for local attachments referenced by note Markdown.
//!
//! The frontend sends the authored reference plus its source note. This module
//! turns that into a canonical graph-relative path without ever exposing an
//! absolute filesystem path over IPC. Every consumer revalidates the resolved
//! path because protocol URLs and open commands are independently forgeable.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use percent_encoding::percent_decode_str;
use same_file::Handle;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::{FileMeta, PinnedGraphRoot};

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

/// An attachment opened through the generation-pinned root capability. The
/// directory handles stay alive with the file so replacing an ancestor after
/// the open cannot redirect a later read.
pub(super) struct OpenAttachment {
    file: fs::File,
    _root: Arc<Dir>,
    _directories: Vec<Dir>,
}

impl OpenAttachment {
    pub(super) fn len(&self) -> std::io::Result<u64> {
        self.file.metadata().map(|metadata| metadata.len())
    }

    /// Read this descriptor only when its complete contents fit within the
    /// caller's explicit budget. The second limit check catches growth after
    /// `metadata()` without ever allocating or reading beyond the budget.
    pub(super) fn read_all(self, max_bytes: u64) -> std::io::Result<Vec<u8>> {
        let file_len = self.len()?;
        if file_len > max_bytes {
            return Err(file_too_large(file_len, max_bytes));
        }
        let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "attachment read limit is too large",
            )
        })?;
        let capacity = usize::try_from(file_len).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file length does not fit in memory",
            )
        })?;
        let mut bytes = Vec::with_capacity(capacity);
        self.file.take(read_limit).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max_bytes {
            return Err(file_too_large(bytes.len() as u64, max_bytes));
        }
        Ok(bytes)
    }

    /// Read an exact, caller-bounded byte range from the already validated
    /// descriptor. This is used by the custom protocol so large media never
    /// needs to be buffered in full.
    pub(super) fn read_range(
        &mut self,
        start: u64,
        length: u64,
        max_bytes: u64,
    ) -> std::io::Result<Vec<u8>> {
        if length > max_bytes {
            return Err(file_too_large(length, max_bytes));
        }
        let capacity = usize::try_from(length).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "attachment byte range does not fit in memory",
            )
        })?;
        let end = start.checked_add(length).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "attachment byte range overflows",
            )
        })?;
        if end > self.len()? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "attachment became shorter while it was being read",
            ));
        }

        self.file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity(capacity);
        self.file.by_ref().take(length).read_to_end(&mut bytes)?;
        if bytes.len() != capacity {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "attachment became shorter while it was being read",
            ));
        }
        Ok(bytes)
    }

    fn identity_handle(&self) -> std::io::Result<Handle> {
        Handle::from_file(self.file.try_clone()?)
    }
}

fn file_too_large(actual: u64, max_bytes: u64) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("file is {actual} bytes; the read limit is {max_bytes} bytes"),
    )
}

/// Holds the ambient-root re-open, attachment handle, and identity handles
/// until the OS opener call returns.
pub(super) struct PathLaunchGuard {
    absolute_path: PathBuf,
    _current_attachment: OpenAttachment,
    _identity_handles: Vec<Handle>,
}

impl PathLaunchGuard {
    pub(super) fn absolute_path(&self) -> &Path {
        &self.absolute_path
    }
}

/// Resolve an attachment reference against a graph root.
pub(super) fn resolve_reference(
    root: &PinnedGraphRoot,
    source_path: &str,
    reference: &str,
    reference_kind: AttachmentReferenceKind,
) -> AppResult<AttachmentResolveOutcome> {
    super::ensure_pinned_root_path_identity(root)?;
    let source_components = visible_wire_components(source_path)?;
    if !source_path.ends_with(".md") {
        return Err(AppError::parse(format!(
            "attachment source is not a Markdown note: {source_path}"
        )));
    }
    let source_dir = &source_components[..source_components.len().saturating_sub(1)];
    let decoded = decode_reference(reference)?;

    let outcome = match reference_kind {
        AttachmentReferenceKind::Markdown => resolve_markdown(root, source_dir, &decoded),
        AttachmentReferenceKind::WikiEmbed => resolve_wiki_embed(root, &decoded),
    }?;
    super::ensure_pinned_root_path_identity(root)?;
    Ok(outcome)
}

fn resolve_markdown(
    root: &PinnedGraphRoot,
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

fn resolve_wiki_embed(
    root: &PinnedGraphRoot,
    reference: &str,
) -> AppResult<AttachmentResolveOutcome> {
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

fn outcome_for_path(root: &PinnedGraphRoot, path: &str) -> AppResult<AttachmentResolveOutcome> {
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
    if reflect_graph_paths::classify_normalized(path)
        == Some(reflect_graph_paths::GraphPathKind::Attachment)
    {
        return Ok(());
    }
    Err(AppError::parse(format!(
        "unsupported local attachment format: {path}"
    )))
}

fn ensure_supported_file_name(file_name: &str) -> AppResult<()> {
    if reflect_graph_paths::classify_normalized(file_name)
        == Some(reflect_graph_paths::GraphPathKind::Attachment)
    {
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

fn candidate_presence(root: &PinnedGraphRoot, path: &str) -> AppResult<CandidatePresence> {
    ensure_supported_path(path)?;
    let components = visible_wire_components(path)?;
    let (file_name, parent_components) = components
        .split_last()
        .ok_or_else(|| AppError::traversal("attachment path is empty"))?;
    let Some(parent) = open_existing_parent(&root.capability, parent_components, path)? else {
        return Ok(CandidatePresence::Missing);
    };

    match parent.symlink_metadata(file_name) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::traversal(format!(
            "attachment path contains a symlink: {path}"
        ))),
        Ok(metadata) if metadata.is_file() => Ok(CandidatePresence::Available),
        Ok(_) => Ok(CandidatePresence::Missing),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let placeholder_name = format!(".{file_name}.icloud");
            match parent.symlink_metadata(&placeholder_name) {
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

fn open_existing_parent(
    root: &Dir,
    components: &[String],
    display_path: &str,
) -> AppResult<Option<Dir>> {
    let mut current = root.try_clone()?;
    for component in components {
        current = match current.open_dir_nofollow(component) {
            Ok(next) => next,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(safe_open_error(display_path, error)),
        };
    }
    Ok(Some(current))
}

/// Open an eligible attachment by walking every parent directory and the leaf
/// with no-follow semantics. Reads must use the returned file handle rather
/// than resolving `root.path.join(path)` again.
pub(super) fn open_existing_attachment(
    root: &PinnedGraphRoot,
    path: &str,
) -> AppResult<OpenAttachment> {
    ensure_supported_path(path)?;
    open_from_capability(root.capability.clone(), path)
}

/// Read a caller-validated visible graph file through the generation-pinned
/// root capability. Every parent and the leaf use no-follow semantics, so AI
/// paths can never turn a symlinked asset or sidecar into bytes from outside
/// the vault. Callers remain responsible for constraining the accepted path
/// class (note, managed asset, or managed description).
pub(super) fn read_existing_visible_file(
    root: &PinnedGraphRoot,
    path: &str,
    max_bytes: u64,
) -> AppResult<Vec<u8>> {
    open_from_capability(root.capability.clone(), path)?
        .read_all(max_bytes)
        .map_err(AppError::from)
}

fn open_from_capability(root: Arc<Dir>, path: &str) -> AppResult<OpenAttachment> {
    let components = visible_wire_components(path)?;
    let (file_name, parent_components) = components
        .split_last()
        .ok_or_else(|| AppError::traversal("attachment path is empty"))?;

    let mut current = root.try_clone()?;
    let mut directories = Vec::with_capacity(parent_components.len() + 1);
    for component in parent_components {
        let next = current
            .open_dir_nofollow(component)
            .map_err(|error| safe_open_error(path, error))?;
        directories.push(current);
        current = next;
    }

    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = match current.open_with(file_name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let placeholder_name = format!(".{file_name}.icloud");
            match current.open_with(&placeholder_name, &options) {
                Ok(placeholder) if placeholder.metadata()?.is_file() => {
                    return Err(AppError::not_found(format!(
                        "attachment is not available on this device: {path}"
                    )))
                }
                Ok(_) => return Err(AppError::not_found(format!("attachment not found: {path}"))),
                Err(placeholder_error)
                    if placeholder_error.kind() == std::io::ErrorKind::NotFound =>
                {
                    return Err(AppError::not_found(format!("attachment not found: {path}")))
                }
                Err(placeholder_error) => return Err(safe_open_error(path, placeholder_error)),
            }
        }
        Err(error) => return Err(safe_open_error(path, error)),
    };
    if !file.metadata()?.is_file() {
        return Err(AppError::not_found(format!("attachment not found: {path}")));
    }
    directories.push(current);
    Ok(OpenAttachment {
        file: file.into_std(),
        _root: root,
        _directories: directories,
    })
}

fn safe_open_error(path: &str, error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return AppError::not_found(format!("attachment not found: {path}"));
    }
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return AppError::io(error.to_string());
    }
    AppError::traversal(format!(
        "attachment path could not be opened without following symlinks: {path}: {error}"
    ))
}

/// Re-open the current ambient pathname immediately before handing it to the
/// OS. Both the root directory and leaf must still identify the capability-
/// pinned objects. The opener APIs accept only a pathname, not a descriptor,
/// so on Unix there remains an unavoidable race between this final check and
/// the external application resolving that pathname.
pub(super) fn revalidate_for_path_launch(
    root: &PinnedGraphRoot,
    path: &str,
    original: &OpenAttachment,
) -> AppResult<PathLaunchGuard> {
    ensure_supported_path(path)?;
    let current_root = Arc::new(Dir::open_ambient_dir(&root.path, ambient_authority())?);

    let pinned_root_identity = Handle::from_file(root.capability.try_clone()?.into_std_file())?;
    let current_root_identity = Handle::from_file(current_root.try_clone()?.into_std_file())?;
    if pinned_root_identity != current_root_identity {
        return Err(AppError::traversal(
            "the graph root path changed before the attachment could be opened",
        ));
    }

    let current_attachment = open_from_capability(current_root, path)?;
    let original_identity = original.identity_handle()?;
    let current_identity = current_attachment.identity_handle()?;
    if original_identity != current_identity {
        return Err(AppError::traversal(
            "the attachment path changed before it could be opened",
        ));
    }

    Ok(PathLaunchGuard {
        absolute_path: root.path.join(path),
        _current_attachment: current_attachment,
        _identity_handles: vec![
            pinned_root_identity,
            current_root_identity,
            original_identity,
            current_identity,
        ],
    })
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn placeholder_for(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.with_file_name(format!(".{name}.icloud")))
}

/// Best-effort iCloud materialization for an explicitly resolved placeholder.
/// Resolution still returns `unavailable`; the watcher causes the frontend to
/// retry after the operating system replaces the stub with the real file.
pub(super) fn request_materialization(root: &PinnedGraphRoot, path: &str) -> AppResult<()> {
    ensure_supported_path(path)?;
    // iCloud exposes only an ambient-path API. Never hand it a path after the
    // selected root has been renamed or replaced; the generation alone cannot
    // detect that filesystem transition.
    super::ensure_pinned_root_path_identity(root)?;

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        let guard = materialization_guard(root, path)?;
        let absolute = root.path.join(path);
        if let Some(placeholder) = placeholder_for(&absolute) {
            crate::icloud::storage::request_download(&placeholder);
        }
        crate::icloud::storage::request_download(&absolute);
        drop(guard);
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let _ = (root, path);
    }
    Ok(())
}

/// Keep the capability and ambient parent/placeholder identities alive until
/// the pathname-only iCloud call returns. A final pathname race is inherent in
/// that API, but replacement before this guard is built fails closed.
#[cfg(any(target_os = "ios", target_os = "macos"))]
struct MaterializationGuard {
    _pinned_parent: Dir,
    _ambient_parent: Dir,
    _pinned_placeholder: cap_std::fs::File,
    _ambient_placeholder: cap_std::fs::File,
    _identities: Vec<Handle>,
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn materialization_guard(root: &PinnedGraphRoot, path: &str) -> AppResult<MaterializationGuard> {
    let components = visible_wire_components(path)?;
    let (file_name, parent_components) = components
        .split_last()
        .ok_or_else(|| AppError::traversal("attachment path is empty"))?;
    let pinned_parent = open_existing_parent(&root.capability, parent_components, path)?
        .ok_or_else(|| AppError::not_found(format!("attachment not found: {path}")))?;

    let ambient_root = Dir::open_ambient_dir(&root.path, ambient_authority()).map_err(|error| {
        AppError::traversal(format!(
            "the graph root path changed before iCloud materialization: {error}"
        ))
    })?;
    let ambient_parent = open_existing_parent(&ambient_root, parent_components, path)?
        .ok_or_else(|| AppError::not_found(format!("attachment not found: {path}")))?;

    let pinned_root_identity = Handle::from_file(root.capability.try_clone()?.into_std_file())?;
    let ambient_root_identity = Handle::from_file(ambient_root.into_std_file())?;
    if pinned_root_identity != ambient_root_identity {
        return Err(AppError::traversal(
            "the graph root path changed before iCloud materialization",
        ));
    }
    let pinned_parent_identity = Handle::from_file(pinned_parent.try_clone()?.into_std_file())?;
    let ambient_parent_identity = Handle::from_file(ambient_parent.try_clone()?.into_std_file())?;
    if pinned_parent_identity != ambient_parent_identity {
        return Err(AppError::traversal(
            "an attachment directory changed before iCloud materialization",
        ));
    }

    let placeholder_name = format!(".{file_name}.icloud");
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let pinned_placeholder = pinned_parent
        .open_with(&placeholder_name, &options)
        .map_err(|error| safe_open_error(path, error))?;
    let ambient_placeholder = ambient_parent
        .open_with(&placeholder_name, &options)
        .map_err(|error| safe_open_error(path, error))?;
    if !pinned_placeholder.metadata()?.is_file() || !ambient_placeholder.metadata()?.is_file() {
        return Err(AppError::not_found(format!(
            "attachment placeholder not found: {path}"
        )));
    }
    let pinned_placeholder_identity =
        Handle::from_file(pinned_placeholder.try_clone()?.into_std())?;
    let ambient_placeholder_identity =
        Handle::from_file(ambient_placeholder.try_clone()?.into_std())?;
    if pinned_placeholder_identity != ambient_placeholder_identity {
        return Err(AppError::traversal(
            "the attachment placeholder changed before iCloud materialization",
        ));
    }

    // Revalidate the ambient root immediately before returning the guard to
    // the caller that invokes iCloud's pathname API.
    super::ensure_pinned_root_path_identity(root)?;
    Ok(MaterializationGuard {
        _pinned_parent: pinned_parent,
        _ambient_parent: ambient_parent,
        _pinned_placeholder: pinned_placeholder,
        _ambient_placeholder: ambient_placeholder,
        _identities: vec![
            pinned_root_identity,
            ambient_root_identity,
            pinned_parent_identity,
            ambient_parent_identity,
            pinned_placeholder_identity,
            ambient_placeholder_identity,
        ],
    })
}

/// List supported attachments through the generation-pinned graph
/// capability. The ambient graph pathname is never consulted, so a root
/// replacement cannot splice files from a different directory into the
/// current generation's catalog.
pub(super) fn list_supported_attachments(root: &PinnedGraphRoot) -> AppResult<Vec<FileMeta>> {
    super::ensure_pinned_root_path_identity(root)?;
    let files = collect_visible_files(root, None, true)?;
    super::ensure_pinned_root_path_identity(root)?;
    Ok(files)
}

/// List visible files below one Reflect-managed attachment root. This is the
/// size/mtime probe used for recently pasted assets; it intentionally accepts
/// description sidecars as well as supported attachment formats, matching the
/// historical `dir_list` contract while pruning hidden paths and symlinks.
pub(super) fn list_reserved_files(root: &PinnedGraphRoot, dir: &str) -> AppResult<Vec<FileMeta>> {
    super::ensure_pinned_root_path_identity(root)?;
    let files = collect_visible_files(root, Some(dir), false)?;
    super::ensure_pinned_root_path_identity(root)?;
    Ok(files)
}

fn collect_visible_files(
    root: &PinnedGraphRoot,
    start: Option<&str>,
    supported_only: bool,
) -> AppResult<Vec<FileMeta>> {
    let (start_components, start_directory) = match start {
        Some(start) => {
            let components = visible_wire_components(start)?;
            let Some(directory) = open_existing_parent(&root.capability, &components, start)?
            else {
                return Ok(Vec::new());
            };
            (components, directory)
        }
        None => (Vec::new(), root.capability.try_clone()?),
    };
    let mut files = Vec::new();
    let mut stack = vec![(start_components, start_directory)];

    while let Some((directory_components, directory)) = stack.pop() {
        for entry in directory.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let metadata = match directory.symlink_metadata(name) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(safe_open_error(name, error)),
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if name.starts_with('.') {
                    continue;
                }
                let next = directory
                    .open_dir_nofollow(name)
                    .map_err(|error| safe_open_error(name, error))?;
                let mut next_components = directory_components.clone();
                next_components.push(name.to_string());
                stack.push((next_components, next));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            let (path, placeholder) = if let Some(logical_name) = icloud_placeholder_target(name) {
                if logical_name.starts_with('.') {
                    continue;
                }
                match directory.symlink_metadata(logical_name) {
                    Ok(logical_metadata) if logical_metadata.is_file() => continue,
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(safe_open_error(logical_name, error)),
                }
                (joined_wire_path(&directory_components, logical_name), true)
            } else {
                if name.starts_with('.') {
                    continue;
                }
                (joined_wire_path(&directory_components, name), false)
            };

            if supported_only {
                if ensure_supported_path(&path).is_err() {
                    continue;
                }
            } else if visible_wire_components(&path).is_err() {
                continue;
            }
            files.push(FileMeta {
                path,
                size: metadata.len(),
                modified_ms: cap_modified_ms(&metadata).unwrap_or(0),
                placeholder,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

fn cap_modified_ms(metadata: &cap_std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn find_unique_filename_candidates(
    root: &PinnedGraphRoot,
    requested_name: &str,
) -> AppResult<Vec<(String, CandidatePresence)>> {
    let mut candidates = Vec::new();
    let mut stack = vec![(Vec::<String>::new(), root.capability.try_clone()?)];
    while let Some((directory_components, directory)) = stack.pop() {
        for entry in directory.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let metadata = match directory.symlink_metadata(name) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(safe_open_error(name, error)),
            };
            if metadata.file_type().is_symlink() {
                let logical_match = icloud_placeholder_target(name)
                    .is_some_and(|target| target.eq_ignore_ascii_case(requested_name));
                if name.eq_ignore_ascii_case(requested_name) || logical_match {
                    return Err(AppError::traversal(format!(
                        "attachment filename matches a symlink: {requested_name}"
                    )));
                }
                continue;
            }
            if metadata.is_dir() {
                if !name.starts_with('.') {
                    let next = directory
                        .open_dir_nofollow(name)
                        .map_err(|error| safe_open_error(name, error))?;
                    let mut next_components = directory_components.clone();
                    next_components.push(name.to_string());
                    stack.push((next_components, next));
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            if let Some(logical_name) = icloud_placeholder_target(name) {
                if !logical_name.starts_with('.')
                    && logical_name.eq_ignore_ascii_case(requested_name)
                    && ensure_supported_file_name(logical_name).is_ok()
                {
                    let logical_path = joined_wire_path(&directory_components, logical_name);
                    let presence = candidate_presence(root, &logical_path)?;
                    if presence != CandidatePresence::Missing {
                        candidates.push((logical_path, presence));
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
            let path = joined_wire_path(&directory_components, name);
            let presence = candidate_presence(root, &path)?;
            if presence != CandidatePresence::Missing {
                candidates.push((path, presence));
            }
        }
    }
    Ok(candidates)
}

fn joined_wire_path(directory_components: &[String], file_name: &str) -> String {
    if directory_components.is_empty() {
        return file_name.to_string();
    }
    format!("{}/{file_name}", directory_components.join("/"))
}

fn icloud_placeholder_target(name: &str) -> Option<&str> {
    reflect_graph_paths::icloud_placeholder_target(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use serde_json::json;
    use std::sync::Arc;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"content").unwrap();
    }

    fn pinned(root: &Path) -> PinnedGraphRoot {
        PinnedGraphRoot {
            path: root.to_path_buf(),
            capability: Arc::new(Dir::open_ambient_dir(root, ambient_authority()).unwrap()),
        }
    }

    fn resolve_reference(
        root: &Path,
        source_path: &str,
        reference: &str,
        reference_kind: AttachmentReferenceKind,
    ) -> AppResult<AttachmentResolveOutcome> {
        super::resolve_reference(&pinned(root), source_path, reference, reference_kind)
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
        for extension in reflect_graph_paths::ATTACHMENT_EXTENSIONS {
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
    fn resolver_and_lists_reject_an_ambient_root_replacement() {
        let parent = tempfile::tempdir().unwrap();
        let root_path = parent.path().join("vault");
        let moved_path = parent.path().join("moved-vault");
        fs::create_dir_all(root_path.join("Original")).unwrap();
        fs::write(root_path.join("Original/photo.png"), b"original").unwrap();
        let root = pinned(&root_path);

        fs::rename(&root_path, &moved_path).unwrap();
        fs::create_dir_all(root_path.join("Replacement")).unwrap();
        fs::write(root_path.join("Replacement/photo.png"), b"replacement").unwrap();

        assert!(matches!(
            super::resolve_reference(
                &root,
                "Plan.md",
                "photo.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap_err(),
            AppError::Traversal { .. }
        ));
        assert!(matches!(
            list_supported_attachments(&root),
            Err(AppError::Traversal { .. })
        ));
        assert!(matches!(
            request_materialization(&root, "Original/remote.png"),
            Err(AppError::Traversal { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn resolver_and_lists_reject_a_descendant_directory_symlink_swap() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(graph.path().join("Media")).unwrap();
        fs::write(graph.path().join("Plan.md"), b"# Plan").unwrap();
        fs::write(outside.path().join("escape.png"), b"outside").unwrap();
        let root = pinned(graph.path());

        fs::rename(graph.path().join("Media"), graph.path().join("OldMedia")).unwrap();
        symlink(outside.path(), graph.path().join("Media")).unwrap();

        let direct_error = super::resolve_reference(
            &root,
            "Plan.md",
            "Media/escape.png",
            AttachmentReferenceKind::Markdown,
        )
        .unwrap_err();
        assert!(matches!(direct_error, AppError::Traversal { .. }));
        assert_eq!(
            super::resolve_reference(
                &root,
                "Plan.md",
                "escape.png",
                AttachmentReferenceKind::WikiEmbed,
            )
            .unwrap(),
            AttachmentResolveOutcome::NotFound
        );
        assert!(list_supported_attachments(&root).unwrap().is_empty());
    }

    #[test]
    fn capability_lists_preserve_placeholder_metadata_and_prune_hidden_paths() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), "Media/photo.png");
        write(graph.path(), "Media/.remote.pdf.icloud");
        write(graph.path(), ".obsidian/hidden.png");
        write(graph.path(), "assets/report.pdf.reflect.md");

        let root = pinned(graph.path());
        let attachments = list_supported_attachments(&root).unwrap();
        assert_eq!(
            attachments
                .iter()
                .map(|file| (file.path.as_str(), file.placeholder))
                .collect::<Vec<_>>(),
            vec![("Media/photo.png", false), ("Media/remote.pdf", true)]
        );
        assert_eq!(
            list_reserved_files(&root, "assets")
                .unwrap()
                .into_iter()
                .map(|file| file.path)
                .collect::<Vec<_>>(),
            vec!["assets/report.pdf.reflect.md"]
        );
        assert!(list_reserved_files(&root, "audio-memos")
            .unwrap()
            .is_empty());
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

    #[cfg(unix)]
    #[test]
    fn capability_open_rejects_symlinked_parents_and_leaves() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "escape.png");
        symlink(outside.path(), graph.path().join("Media")).unwrap();
        symlink(
            outside.path().join("escape.png"),
            graph.path().join("escape.png"),
        )
        .unwrap();
        let root = pinned(graph.path());

        for path in ["Media/escape.png", "escape.png"] {
            let error = open_existing_attachment(&root, path)
                .err()
                .expect("symlinked attachment path must be rejected");
            assert!(matches!(error, AppError::Traversal { .. }), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn opened_descriptor_cannot_be_redirected_by_a_leaf_swap() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(graph.path().join("photo.png"), b"vault bytes").unwrap();
        fs::write(outside.path().join("photo.png"), b"outside bytes").unwrap();
        let root = pinned(graph.path());
        let attachment = open_existing_attachment(&root, "photo.png").unwrap();

        fs::rename(
            graph.path().join("photo.png"),
            graph.path().join("original.png"),
        )
        .unwrap();
        symlink(
            outside.path().join("photo.png"),
            graph.path().join("photo.png"),
        )
        .unwrap();

        assert_eq!(attachment.read_all(1024).unwrap(), b"vault bytes");
    }

    #[test]
    fn capability_open_preserves_icloud_unavailable_semantics() {
        let graph = tempfile::tempdir().unwrap();
        write(graph.path(), ".remote.png.icloud");
        let root = pinned(graph.path());

        let error = open_existing_attachment(&root, "remote.png")
            .err()
            .expect("placeholder must not be served as attachment bytes");
        let AppError::NotFound { message } = error else {
            panic!("placeholder should be unavailable, not readable");
        };
        assert!(message.contains("not available on this device"));
    }

    #[cfg(unix)]
    #[test]
    fn pinned_root_survives_replacement_but_path_launch_fails_closed() {
        let parent = tempfile::tempdir().unwrap();
        let root_path = parent.path().join("vault");
        let moved_path = parent.path().join("moved-vault");
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("photo.png"), b"vault bytes").unwrap();
        let root = pinned(&root_path);

        fs::rename(&root_path, &moved_path).unwrap();
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("photo.png"), b"replacement bytes").unwrap();

        let attachment = open_existing_attachment(&root, "photo.png").unwrap();
        let launch_error = revalidate_for_path_launch(&root, "photo.png", &attachment)
            .err()
            .expect("replaced ambient root must be rejected by the pathname launcher");
        assert!(matches!(launch_error, AppError::Traversal { .. }));
        assert_eq!(attachment.read_all(1024).unwrap(), b"vault bytes");
    }

    #[test]
    fn descriptor_reads_enforce_the_callers_byte_budget() {
        let graph = tempfile::tempdir().unwrap();
        fs::write(graph.path().join("photo.png"), b"12345").unwrap();
        let root = pinned(graph.path());

        let exact = open_existing_attachment(&root, "photo.png").unwrap();
        assert_eq!(exact.read_all(5).unwrap(), b"12345");

        let too_small = open_existing_attachment(&root, "photo.png").unwrap();
        let error = too_small.read_all(4).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);

        let mut ranged = open_existing_attachment(&root, "photo.png").unwrap();
        assert_eq!(ranged.read_range(1, 3, 3).unwrap(), b"234");
        let error = ranged.read_range(0, 4, 3).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[cfg(unix)]
    #[test]
    fn path_launch_revalidation_rejects_a_replaced_leaf() {
        let graph = tempfile::tempdir().unwrap();
        fs::write(graph.path().join("photo.png"), b"vault bytes").unwrap();
        let root = pinned(graph.path());
        let attachment = open_existing_attachment(&root, "photo.png").unwrap();

        fs::rename(
            graph.path().join("photo.png"),
            graph.path().join("original.png"),
        )
        .unwrap();
        fs::write(graph.path().join("photo.png"), b"replacement bytes").unwrap();

        let error = revalidate_for_path_launch(&root, "photo.png", &attachment)
            .err()
            .expect("a replaced attachment leaf must fail identity validation");
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
