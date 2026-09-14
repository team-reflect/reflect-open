use serde_json::{json, Value};
use tauri::{Manager, State};
use super::GraphState;
use reflect_x_archive as archive;

#[tauri::command]
pub async fn x_archive_read(
    state: State<'_, GraphState>, generation: u64, post_id: String,
) -> Result<Option<Value>, String> {
    let root = super::root_for_generation(&state, generation).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || archive::read_post(&root, &post_id)
        .map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn x_archive_write(
    state: State<'_, GraphState>, generation: u64, post_id: String,
    expected: Option<String>, value: Value,
) -> Result<bool, String> {
    let root = super::root_for_generation(&state, generation).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || archive::write_post(&root, &post_id,
        expected.as_deref(), &value).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn x_archive_processed(
    state: State<'_, GraphState>, generation: u64, event: String,
) -> Result<(), String> {
    let root = super::root_for_generation(&state, generation).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || archive::mark_processed(&root, &event)
        .map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn x_archive_resolve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, generation: u64, post_id: String,
) -> Result<Option<Value>, String> {
    let root = super::root_for_generation(&app.state::<GraphState>(), generation)
        .map_err(|error| error.to_string())?;
    let value = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Option<Value>> {
        let Some(post) = archive::read_post(&root, &post_id)? else { return Ok(None) };
        let mut resources = Vec::new();
        for resource in post["resources"].as_array().ok_or_else(|| anyhow::anyhow!("invalid-resources"))? {
            let url = resource["url"].as_str().ok_or_else(|| anyhow::anyhow!("invalid-url"))?;
            let hash = archive::hash_url(url)?;
            let job = archive::ensure_resource(&root, &post_id, &hash)?;
            resources.push(json!({"url":url,"hash":hash,"state":job.state,
                "error":job.resource.error,"bytes":job.receipt.map(|receipt| receipt.bytes)}));
        }
        Ok(Some(json!({"archive":post,"resources":resources})))
    }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
    super::root_for_generation(&app.state::<GraphState>(), generation)
        .map_err(|error| error.to_string())?;
    Ok(value)
}

#[tauri::command]
pub async fn x_archive_owners(
    state: State<'_, GraphState>, asset_path: String,
) -> Result<Vec<String>, String> {
    let root = super::current_root(&state).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<String>> {
        if !asset_path.starts_with("assets/x/") { return Ok(vec![]); }
        let directory = archive::safe_path(&root, "assets/x")?;
        let mut owners = Vec::new();
        if !directory.is_dir() { return Ok(owners); }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            let Some(id) = name.strip_prefix("post-").and_then(|name| name.strip_suffix(".json")) else { continue };
            if !archive::valid_id(id) { continue; }
            let Some(post) = archive::read_post(&root, id)? else { continue };
            let Some(resources) = post["resources"].as_array() else { continue };
            let owns = resources.iter().any(|resource| {
                let Some(url) = resource["url"].as_str() else { return false };
                let Ok(hash) = archive::hash_url(url) else { return false };
                archive::get_candidate_names(&hash).unwrap_or_default()
                    .iter().any(|name| format!("assets/x/{name}") == asset_path)
            });
            if owns { owners.push(format!("assets/x/{name}")); }
        }
        Ok(owners)
    }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

