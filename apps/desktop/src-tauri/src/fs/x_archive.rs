use super::x_archive_store as archive;
use super::GraphState;
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

async fn blocking<T: Send + 'static>(
    root: PathBuf,
    action: impl FnOnce(PathBuf) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || action(root))
        .await
        .map_err(|error| AppError::io(error.to_string()))?
}

fn download_media<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    generation: u64,
    urls: Vec<String>,
) {
    for url in urls {
        let app = app.clone();
        let root = root.clone();
        tauri::async_runtime::spawn(async move {
            match super::x_download::download(root, url).await {
                Ok(receipt) => {
                    if super::root_for_generation(&app.state::<GraphState>(), generation).is_ok() {
                        let _ = app.emit("index:changed", json!([{ "path": format!("assets/x/{}", receipt.name), "kind": "upsert" }]));
                    }
                }

                Err(error) => tracing::warn!(?error, "X media download failed"),
            }
        });
    }
}

#[tauri::command]
pub async fn x_archive_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    value: Value,
) -> AppResult<()> {
    let root = super::root_for_generation(&app.state::<GraphState>(), generation)?;
    let saved = value;
    let saved = blocking(root.clone(), move |root| {
        let view = archive::post_view(&saved)?;
        let id = &view.data.id;
        archive::atomic_json(&root, &format!("assets/x/post-{id}.json"), &saved)?;
        Ok(saved)
    })
    .await?;
    download_media(app, root, generation, archive::media_urls(&saved)?);
    Ok(())
}

#[tauri::command]
pub async fn x_archive_resolve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    post_id: String,
) -> AppResult<Option<Value>> {
    let root = super::root_for_generation(&app.state::<GraphState>(), generation)?;
    let post = blocking(root.clone(), move |root| {
        archive::read_post(&root, &post_id)
    })
    .await?;
    let Some(post) = post else {
        return Ok(None);
    };
    let urls = archive::media_urls(&post)?;
    let resources: Vec<_> = urls
        .iter()
        .filter_map(|url| {
            archive::hash_url(url)
                .ok()
                .map(|hash| json!({"url": url, "hash": hash}))
        })
        .collect();
    // Archives synced from another device also resume missing downloads when opened.
    // Resolution has no durable job state and never rewrites the post JSON.
    download_media(app, root, generation, urls);
    Ok(Some(json!({"archive": post, "resources": resources})))
}

#[tauri::command]

pub async fn x_archive_owners(
    state: State<'_, GraphState>,
    asset_path: String,
    generation: Option<u64>,
) -> AppResult<Vec<String>> {
    let root = match generation {
        Some(generation) => super::root_for_generation(&state, generation)?,
        None => super::current_root(&state)?,
    };
    blocking(root, move |root| {
        if !asset_path.starts_with("assets/x/") {
            return Ok(vec![]);
        }
        let directory = super::resolve::resolve(&root, "assets/x")?;
        let mut owners = Vec::new();
        if !directory.is_dir() {
            return Ok(owners);
        }
        // The synced JSON is authoritative. Device-local download state would miss
        // owners captured on another device and break private-note classification.
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(id) = name
                .strip_prefix("post-")
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            if !archive::valid_id(id) {
                continue;
            }
            let Some(post) = archive::read_post(&root, id)? else {
                continue;
            };
            if archive::media_urls(&post)?.iter().any(|url| {
                archive::hash_url(url)
                    .ok()
                    .and_then(|hash| archive::get_candidate_names(&hash).ok())
                    .is_some_and(|names| {
                        names
                            .iter()
                            .any(|name| format!("assets/x/{name}") == asset_path)
                    })
            }) {
                owners.push(format!("assets/x/{name}"));
            }
        }
        Ok(owners)
    })
    .await
}
