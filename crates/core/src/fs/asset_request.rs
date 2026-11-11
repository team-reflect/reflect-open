//! Answers a `reflect-asset://` request: which file it names, the MIME type
//! to serve it with, and the bytes a `Range` header selects. The shell owns
//! the scheme handler and the file read.
//!
//! The percent-decoded request path is `<generation>/<graph-relative path>`
//! for a graph file ([`super::asset_protocol`]) or
//! `<generation>/x-media/<post>/<hash>` for archived X media
//! ([`super::x_media_protocol`]).

use std::io::Read;
use std::path::PathBuf;

use reflect_types::AppError;

use super::asset_protocol::{
    STATUS_FORBIDDEN, asset_mime, is_preview_safe_raster_mime, resolve_asset_path,
};
use super::x_media_protocol::{STATUS_INTERNAL_ERROR, STATUS_NOT_FOUND, parse_x_media_path};
use crate::Core;

/// The query parameter that asks for raster images only.
const PREVIEW_RASTER_QUERY: &str = "reflect-preview=raster";
/// HTTP status for a non-raster file in a raster-only preview.
const STATUS_UNSUPPORTED_MEDIA_TYPE: u16 = 415;
/// HTTP status for a `Range` header that selects no byte of the file.
const STATUS_RANGE_NOT_SATISFIABLE: u16 = 416;
/// How many leading bytes are read to sniff the MIME type.
const MIME_SNIFF_LEN: u64 = 64 * 1024;

/// The file to serve for an asset request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AssetFile {
    /// The absolute path to read.
    pub path: PathBuf,
    /// The `Content-Type` to serve.
    pub mime: String,
    /// The length of the file in bytes.
    pub total: u64,
    /// The first and last byte a single-range `Range` header selects. `None`
    /// serves the whole file.
    pub range: Option<(u64, u64)>,
}

/// The HTTP status to refuse an asset request with.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AssetRefusal {
    pub status: u16,
    /// The length of the file, for the `Content-Range` of a 416.
    pub total: Option<u64>,
}

impl From<u16> for AssetRefusal {
    fn from(status: u16) -> Self {
        Self {
            status,
            total: None,
        }
    }
}

impl Core {
    /// Resolves an asset request from its percent-decoded path, its query
    /// string and its `Range` header. An X media request waits for the
    /// download, and a graph file in iCloud for its materialization.
    pub async fn asset_resolve(
        &self,
        request_path: &str,
        query: Option<&str>,
        range: Option<&str>,
    ) -> Result<AssetFile, AssetRefusal> {
        let (path, mime, total) = if request_path.split('/').nth(1) == Some("x-media") {
            self.x_media_asset(request_path).await?
        } else {
            let raster_only =
                query.is_some_and(|query| query.split('&').any(|p| p == PREVIEW_RASTER_QUERY));
            self.graph_asset(request_path, raster_only).await?
        };
        Ok(AssetFile {
            path,
            mime,
            total,
            range: selected_range(range, total)?,
        })
    }

    async fn graph_asset(
        &self,
        request_path: &str,
        raster_only: bool,
    ) -> Result<(PathBuf, String, u64), AssetRefusal> {
        let asset = resolve_asset_path(&self.graph, request_path)?;
        let path = asset.path.clone();
        let read = self
            .spawn_blocking(move || {
                let read = || -> std::io::Result<(Vec<u8>, u64)> {
                    let file = std::fs::File::open(&path)?;
                    let total = file.metadata()?.len();
                    let mut head = Vec::new();
                    file.take(MIME_SNIFF_LEN).read_to_end(&mut head)?;
                    Ok((head, total))
                };
                Ok(read().map_err(|err| match err.kind() {
                    std::io::ErrorKind::NotFound => STATUS_NOT_FOUND,
                    std::io::ErrorKind::PermissionDenied => STATUS_FORBIDDEN,
                    _ => STATUS_INTERNAL_ERROR,
                }))
            })
            .await;
        let (head, total) = read.unwrap_or(Err(STATUS_INTERNAL_ERROR))?;
        let mime = asset_mime(&head, &asset.relative_path);
        if raster_only && !is_preview_safe_raster_mime(&mime) {
            return Err(STATUS_UNSUPPORTED_MEDIA_TYPE.into());
        }
        Ok((asset.path, mime, total))
    }

    async fn x_media_asset(
        &self,
        request_path: &str,
    ) -> Result<(PathBuf, String, u64), AssetRefusal> {
        let file = self.x_media_file(parse_x_media_path(request_path)?).await?;
        let relative = format!("assets/x/{}", file.receipt.name);
        let expected = file.receipt.bytes;
        let path = self
            .spawn_blocking(move || {
                let path = reflect_graph_io::resolve(&file.root, &relative)?;
                // A file of another length changed after the download.
                if std::fs::metadata(&path)?.len() != expected {
                    return Err(AppError::io("the X media file changed"));
                }
                Ok(path)
            })
            .await
            .map_err(|err| match err {
                AppError::Traversal { .. } => STATUS_FORBIDDEN,
                _ => STATUS_INTERNAL_ERROR,
            })?;
        Ok((path, file.receipt.mime, expected))
    }
}

/// The first and last byte `header` selects from a file of `total` bytes. A
/// header with several ranges selects the whole file.
fn selected_range(header: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, AssetRefusal> {
    let Some(header) = header else {
        return Ok(None);
    };
    let ranges = http_range_header::parse_range_header(header)
        .and_then(|parsed| parsed.validate(total))
        .map_err(|_| AssetRefusal {
            status: STATUS_RANGE_NOT_SATISFIABLE,
            total: Some(total),
        })?;
    match ranges.as_slice() {
        [range] => Ok(Some((*range.start(), *range.end()))),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{AssetRefusal, selected_range};
    use crate::test_support::core;

    #[test]
    fn a_range_header_selects_one_range_or_is_unsatisfiable() {
        assert_eq!(selected_range(None, 10), Ok(None));
        assert_eq!(selected_range(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(selected_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(selected_range(Some("bytes=7-"), 10), Ok(Some((7, 9))));
        assert_eq!(selected_range(Some("bytes=0-1,3-4"), 10), Ok(None));
        let unsatisfiable = Err(AssetRefusal {
            status: 416,
            total: Some(10),
        });
        assert_eq!(selected_range(Some("bytes=10-"), 10), unsatisfiable);
        assert_eq!(selected_range(Some("bytes=4-2"), 10), unsatisfiable);
    }

    #[test]
    fn a_graph_file_resolves_with_its_mime_length_and_range() {
        let dir = tempfile::tempdir().unwrap();
        let core = core();
        let generation = core
            .graph_open(dir.path().to_string_lossy().into_owned())
            .unwrap()
            .generation;
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        // The PNG signature, then padding.
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(100, 0);
        std::fs::write(dir.path().join("assets/a.png"), &png).unwrap();
        std::fs::write(dir.path().join("assets/a.pdf"), b"%PDF-1.7").unwrap();
        let resolve = |path: String, query: Option<&str>, range: Option<&str>| {
            core.runtime
                .block_on(core.asset_resolve(&path, query, range))
        };
        let status =
            |path: String, query: Option<&str>| resolve(path, query, None).unwrap_err().status;

        let file = resolve(
            format!("{generation}/assets/a.png"),
            None,
            Some("bytes=10-19"),
        )
        .unwrap();
        assert!(file.path.ends_with("assets/a.png"));
        assert_eq!((file.mime.as_str(), file.total), ("image/png", 100));
        assert_eq!(file.range, Some((10, 19)));

        let raster = Some("reflect-preview=raster");
        assert!(resolve(format!("{generation}/assets/a.png"), raster, None).is_ok());
        assert_eq!(status(format!("{generation}/assets/a.pdf"), raster), 415);
        assert_eq!(status(format!("{generation}/assets/none.png"), None), 404);
        assert_eq!(
            status(format!("{}/assets/a.png", generation + 1), None),
            403
        );
        assert_eq!(status("assets/a.png".into(), None), 400);
        assert_eq!(status(format!("{generation}/x-media/nope/abc"), None), 400);
        assert_eq!(
            status(format!("{generation}/x-media/123/{}", "a".repeat(64)), None),
            404
        );
    }
}
