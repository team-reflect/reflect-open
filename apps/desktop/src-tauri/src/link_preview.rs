//! Apple LinkPresentation preview-image capability.
//!
//! Apple platforms ask the system for one representative image. Other
//! platforms return no image and never perform a network request.

use crate::error::AppResult;

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
