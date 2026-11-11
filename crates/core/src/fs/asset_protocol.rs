//! The path half of the `reflect-asset://` protocol: which graph file a
//! request names, and the MIME type its bytes are served with. The shell owns
//! the scheme handler and the file read.
//!
//! Request path shape: `<generation>/<graph-relative path>`. The generation
//! pins the request to the graph session that issued it, exactly like
//! mutating commands — a request racing a graph switch is refused, never
//! resolved against the new graph. The path must be a supported attachment
//! and passes the shared symlink-aware traversal guard before any IO.
//! Passive previews are served only when byte sniffing identifies PNG, JPEG,
//! GIF, or WebP content, so an SVG renamed with a raster extension cannot
//! load subresources there.

use std::path::PathBuf;

use reflect_graph_io::{GraphState, ensure_readable_attachment_path, resolve, root_for_generation};

/// HTTP status for a malformed request path.
pub const STATUS_BAD_REQUEST: u16 = 400;
/// HTTP status for a request the graph session or path guard refuses.
pub const STATUS_FORBIDDEN: u16 = 403;

/// The graph file one asset request names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPath {
    /// The absolute, traversal-guarded path to read.
    pub path: PathBuf,
    /// The graph-relative path from the request, for MIME detection.
    pub relative_path: String,
}

/// Resolves `request_path` (`<generation>/<graph-relative path>`, already
/// percent-decoded) to the file to serve, or the HTTP status to refuse it
/// with.
pub fn resolve_asset_path(graph: &GraphState, request_path: &str) -> Result<AssetPath, u16> {
    let (generation, rel) = parse_request_path(request_path)?;
    let root = root_for_generation(graph, generation).map_err(|_| STATUS_FORBIDDEN)?;
    let path = resolve(&root, rel).map_err(|_| STATUS_FORBIDDEN)?;
    Ok(AssetPath {
        path,
        relative_path: rel.to_string(),
    })
}

/// Split `<generation>/<graph-relative path>` and vet the path shape. Any
/// supported attachment anywhere in the vault qualifies, mirroring
/// `asset_open`: an adopted vault keeps its images beside its notes. Notes,
/// hidden components, and traversal shapes stay forbidden.
fn parse_request_path(request_path: &str) -> Result<(u64, &str), u16> {
    let (generation, rel) = request_path.split_once('/').ok_or(STATUS_BAD_REQUEST)?;
    let generation: u64 = generation.parse().map_err(|_| STATUS_BAD_REQUEST)?;
    ensure_readable_attachment_path(rel).map_err(|_| STATUS_FORBIDDEN)?;
    Ok((generation, rel))
}

/// Whether `mime` is a raster type a passive preview may load.
pub fn is_preview_safe_raster_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// The MIME type for `content` read from `uri`: sniffed from the bytes, and
/// from the extension when sniffing finds nothing or plain text.
// https://github.com/tauri-apps/tauri/blob/tauri-utils-v2.10.2/crates/tauri-utils/src/mime_type.rs#L54-L99
pub fn asset_mime(content: &[u8], uri: &str) -> String {
    let mime = if uri.ends_with(".svg") {
        // when reading svg, we can't use `infer`
        None
    } else {
        infer::get(content).map(|info| info.mime_type())
    };

    match mime {
        Some(mime) if mime == MIMETYPE_PLAIN => mime_from_uri(uri).to_string(),
        None => mime_from_uri(uri).to_string(),
        Some(mime) => mime.to_string(),
    }
}

const MIMETYPE_PLAIN: &str = "text/plain";

fn mime_from_uri(uri: &str) -> &'static str {
    let suffix = uri.split('.').next_back();
    match suffix {
        Some("bin") => "application/octet-stream",
        Some("css" | "less" | "sass" | "styl") => "text/css",
        Some("csv") => "text/csv",
        Some("html") => "text/html",
        Some("ico") => "image/vnd.microsoft.icon",
        Some("js") => "text/javascript",
        Some("json") => "application/json",
        Some("jsonld") => "application/ld+json",
        Some("mjs") => "text/javascript",
        Some("mp4") => "video/mp4",
        Some("rtf") => "application/rtf",
        Some("svg") => "image/svg+xml",
        Some("txt") => MIMETYPE_PLAIN,
        Some(_) => "text/html",
        None => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_generation_pinned_asset_path() {
        assert_eq!(
            parse_request_path("3/assets/cat.png").unwrap(),
            (3, "assets/cat.png"),
        );
        assert_eq!(
            parse_request_path("12/assets/sub dir/photo 1.jpeg").unwrap(),
            (12, "assets/sub dir/photo 1.jpeg"),
        );
        assert_eq!(
            parse_request_path("3/Projects/Media/cat.png").unwrap(),
            (3, "Projects/Media/cat.png"),
        );
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(
            parse_request_path("assets/cat.png").unwrap_err(),
            STATUS_BAD_REQUEST,
        );
        assert_eq!(parse_request_path("3").unwrap_err(), STATUS_BAD_REQUEST);
        assert_eq!(
            parse_request_path("nope/assets/cat.png").unwrap_err(),
            STATUS_BAD_REQUEST,
        );
    }

    #[test]
    fn rejects_notes_hidden_and_traversal_paths() {
        assert_eq!(
            parse_request_path("3/notes/secret.md").unwrap_err(),
            STATUS_FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/.obsidian/cat.png").unwrap_err(),
            STATUS_FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/../cat.png").unwrap_err(),
            STATUS_FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets").unwrap_err(),
            STATUS_FORBIDDEN,
        );
        assert_eq!(
            parse_request_path("3/assets/").unwrap_err(),
            STATUS_FORBIDDEN,
        );
    }

    #[test]
    fn preview_raster_filter_uses_sniffed_content_not_the_filename() {
        let disguised_svg = br#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#;
        let svg_mime = asset_mime(disguised_svg, "assets/disguised.png");
        assert_ne!(svg_mime, "image/png");
        assert!(!is_preview_safe_raster_mime(&svg_mime));

        let png_signature = b"\x89PNG\r\n\x1a\n";
        let png_mime = asset_mime(png_signature, "assets/image.bin");
        assert_eq!(png_mime, "image/png");
        assert!(is_preview_safe_raster_mime(&png_mime));
    }
}
