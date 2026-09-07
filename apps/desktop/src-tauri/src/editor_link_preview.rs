//! Public-internet metadata and favicon primitives for editor link previews.

use std::io::Cursor;

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::web_fetch::{fetch_public_html, fetch_public_image};

const ICON_FETCH_MAX_BYTES: usize = 512 * 1024;
const ICON_MAX_DIMENSION: u32 = 1024;
const ICON_MAX_ALLOC: u64 = 16 * 1024 * 1024;
const ICON_TARGET_DIMENSION: u32 = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkPreviewHtml {
    html: String,
    final_url: String,
}

/// Fetch editor link-preview HTML from public internet destinations only.
#[tauri::command]
pub(crate) async fn link_preview_fetch_html(url: String) -> AppResult<LinkPreviewHtml> {
    let response = fetch_public_html(&url).await?;
    Ok(LinkPreviewHtml {
        html: String::from_utf8_lossy(&response.body).into_owned(),
        final_url: response.final_url,
    })
}

fn is_raster_content_type(content_type: &str) -> bool {
    matches!(
        content_type.split(';').next().unwrap_or("").trim(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    )
}

pub(crate) fn validate_raster_content_type(url: &str, content_type: &str) -> AppResult<()> {
    if !is_raster_content_type(content_type) {
        return Err(AppError::parse(format!(
            "{url} is not a supported raster image ({content_type})"
        )));
    }
    Ok(())
}

fn normalize_icon(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| AppError::parse(format!("favicon format is invalid: {error}")))?;
    let format = reader
        .format()
        .ok_or_else(|| AppError::parse("favicon format is unknown"))?;
    if !matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::Gif
            | image::ImageFormat::WebP
            | image::ImageFormat::Ico
    ) {
        return Err(AppError::parse("favicon is not a supported raster image"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(ICON_MAX_DIMENSION);
    limits.max_image_height = Some(ICON_MAX_DIMENSION);
    limits.max_alloc = Some(ICON_MAX_ALLOC);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| AppError::parse(format!("favicon does not decode: {error}")))?;
    let normalized = decoded.thumbnail(ICON_TARGET_DIMENSION, ICON_TARGET_DIMENSION);
    let mut png = Vec::new();
    normalized
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| AppError::io(format!("favicon re-encode failed: {error}")))?;
    Ok(png)
}

/// Fetch a public raster favicon, normalize it, and return a PNG data URL.
#[tauri::command]
pub(crate) async fn link_preview_fetch_icon(url: String) -> AppResult<String> {
    let response =
        fetch_public_image(&url, ICON_FETCH_MAX_BYTES, validate_raster_content_type).await?;
    let png = tauri::async_runtime::spawn_blocking(move || normalize_icon(&response.body))
        .await
        .map_err(|error| AppError::io(format!("favicon task failed: {error}")))??;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_a_raster_icon_to_small_png() {
        let source = image::DynamicImage::new_rgba8(128, 64);
        let mut bytes = Vec::new();
        source
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();

        let normalized = normalize_icon(&bytes).unwrap();
        let decoded =
            image::load_from_memory_with_format(&normalized, image::ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 16));
    }

    #[test]
    fn rejects_malformed_and_oversized_icons() {
        assert!(normalize_icon(b"not an image").is_err());

        let source = image::DynamicImage::new_rgba8(ICON_MAX_DIMENSION + 1, 1);
        let mut bytes = Vec::new();
        source
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        assert!(normalize_icon(&bytes).is_err());
    }

    #[test]
    fn accepts_only_bounded_raster_mime_types() {
        assert!(is_raster_content_type("image/png; charset=binary"));
        assert!(is_raster_content_type("image/vnd.microsoft.icon"));
        assert!(!is_raster_content_type("image/svg+xml"));
        assert!(!is_raster_content_type("application/octet-stream"));
    }
}
