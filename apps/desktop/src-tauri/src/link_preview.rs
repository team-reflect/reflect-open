//! Apple LinkPresentation preview-image capability.
//!
//! Apple platforms ask the system for one representative image. Editor link
//! previews use the bounded public-internet transport on every platform.

use std::io::Cursor;

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::web_fetch::{fetch_bytes, fetch_html, NetworkScope};

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
    let response = fetch_html(&url, NetworkScope::PublicHttp).await?;
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
pub(crate) async fn link_preview_fetch_icon(url: String) -> AppResult<Option<String>> {
    let response = fetch_bytes(
        &url,
        NetworkScope::PublicHttp,
        "image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.1",
        ICON_FETCH_MAX_BYTES,
    )
    .await?;
    if !is_raster_content_type(&response.content_type) {
        return Err(AppError::parse(format!(
            "{} is not a supported raster favicon ({})",
            response.final_url, response.content_type
        )));
    }
    let png = tauri::async_runtime::spawn_blocking(move || normalize_icon(&response.body))
        .await
        .map_err(|error| AppError::io(format!("favicon task failed: {error}")))??;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )))
}

pub(crate) async fn fetch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
) -> AppResult<Option<Vec<u8>>> {
    platform::fetch(app, url).await
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use block2::RcBlock;
    use dispatch2::MainThreadBound;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSData, NSError, NSString, NSURL};
    use objc2_link_presentation::{LPLinkMetadata, LPMetadataProvider};

    use crate::error::{AppError, AppResult};

    const PROVIDER_TIMEOUT_SECONDS: f64 = 15.0;
    const RECEIVER_TIMEOUT: Duration = Duration::from_secs(20);
    const MAX_PROVIDER_BYTES: usize = 16 * 1024 * 1024;
    const IMAGE_TYPE_IDENTIFIER: &str = "public.image";

    type PreviewResult = Result<Option<Vec<u8>>, String>;
    type Provider = Arc<MainThreadBound<Retained<LPMetadataProvider>>>;

    pub async fn fetch<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        url: &str,
    ) -> AppResult<Option<Vec<u8>>> {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err(AppError::parse("link preview requires an http(s) URL"));
        }

        let (sender, receiver) = mpsc::sync_channel::<PreviewResult>(1);
        let url = url.to_owned();
        app.run_on_main_thread(move || {
            let start_sender = sender.clone();
            if let Err(message) = start(&url, start_sender) {
                let _ = sender.send(Err(message));
            }
        })
        .map_err(|error| AppError::io(format!("could not schedule link preview: {error}")))?;

        let received =
            tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(RECEIVER_TIMEOUT))
                .await
                .map_err(|error| AppError::io(format!("link preview task failed: {error}")))?;

        received
            .map_err(|_| AppError::Network {
                message: "LinkPresentation did not finish".into(),
            })?
            .map_err(|message| AppError::Network { message })
    }

    fn start(url: &str, sender: mpsc::SyncSender<PreviewResult>) -> Result<(), String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "LinkPresentation was not started on the main thread".to_string())?;
        let url = NSURL::URLWithString(&NSString::from_str(url))
            .ok_or_else(|| "LinkPresentation rejected the URL".to_string())?;
        let provider: Provider = Arc::new(MainThreadBound::new(
            unsafe { LPMetadataProvider::new() },
            mtm,
        ));
        unsafe {
            provider.get(mtm).setTimeout(PROVIDER_TIMEOUT_SECONDS);
            provider.get(mtm).setShouldFetchSubresources(true);
        }

        let provider_lifetime = Arc::clone(&provider);
        let handler = RcBlock::new(move |metadata: *mut LPLinkMetadata, error: *mut NSError| {
            let _provider_lifetime = &provider_lifetime;
            let Some(metadata) = (unsafe { metadata.as_ref() }) else {
                let _ = sender.send(Err(error_message(
                    error,
                    "LinkPresentation returned no metadata",
                )));
                return;
            };
            let Some(image_provider) = (unsafe { metadata.imageProvider() }) else {
                let _ = sender.send(Ok(None));
                return;
            };

            let data_sender = sender.clone();
            let data_handler = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = match unsafe { data.as_ref() } {
                    Some(data) if data.len() <= MAX_PROVIDER_BYTES => Ok(Some(data.to_vec())),
                    Some(_) => Err("LinkPresentation image is too large".into()),
                    None => Err(error_message(
                        error,
                        "LinkPresentation returned no image data",
                    )),
                };
                let _ = data_sender.send(result);
            });
            unsafe {
                image_provider.loadDataRepresentationForTypeIdentifier_completionHandler(
                    &NSString::from_str(IMAGE_TYPE_IDENTIFIER),
                    &data_handler,
                );
            }
        });

        unsafe {
            provider
                .get(mtm)
                .startFetchingMetadataForURL_completionHandler(&url, &handler);
        }
        Ok(())
    }

    fn error_message(error: *mut NSError, fallback: &str) -> String {
        unsafe { error.as_ref() }
            .map(|error| error.localizedDescription().to_string())
            .unwrap_or_else(|| fallback.to_string())
    }
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

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    use crate::error::AppResult;

    pub async fn fetch<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
        _url: &str,
    ) -> AppResult<Option<Vec<u8>>> {
        Ok(None)
    }
}
