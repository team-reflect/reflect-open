use reflect_graph_io::x_archive_store as archive;
use reflect_graph_io::{current_root, resolve, root_for_generation};
use reflect_types::AppResult;
use reflect_types::FileChange;
use reflect_types::events::INDEX_CHANGED;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use crate::Core;

impl Core {
    async fn blocking<T: Send + 'static>(
        &self,
        root: PathBuf,
        action: impl FnOnce(PathBuf) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        self.spawn_blocking(move || action(root)).await
    }

    fn download_media(self: &Arc<Self>, root: PathBuf, generation: u64, urls: Vec<String>) {
        for url in urls {
            let core: Weak<Core> = Arc::downgrade(self);
            let root = root.clone();
            self.runtime.spawn(async move {
                match super::x_download::download(root, url).await {
                    Ok(receipt) => {
                        let Some(core) = core.upgrade() else {
                            return;
                        };
                        if root_for_generation(&core.graph, generation).is_ok() {
                            let change =
                                FileChange::upsert(format!("assets/x/{}", receipt.name), None);
                            if let Ok(payload) = serde_json::to_value(vec![change]) {
                                core.host().emit(INDEX_CHANGED, payload);
                            }
                        }
                    }

                    Err(error) => tracing::warn!(?error, "X media download failed"),
                }
            });
        }
    }

    /// Command: save an X post archive and start downloading its media.
    pub async fn x_archive_write(self: &Arc<Self>, generation: u64, value: Value) -> AppResult<()> {
        let root = root_for_generation(&self.graph, generation)?;
        let saved = value;
        let saved = self
            .blocking(root.clone(), move |root| {
                let view = archive::post_view(&saved)?;
                let id = &view.data.id;
                archive::atomic_json(&root, &format!("assets/x/post-{id}.json"), &saved)?;
                Ok(saved)
            })
            .await?;
        self.download_media(root, generation, archive::media_urls(&saved)?);
        Ok(())
    }

    /// Command: the archived X post with `post_id` and its media resources,
    /// resuming any missing media downloads.
    pub async fn x_archive_resolve(
        self: &Arc<Self>,
        generation: u64,
        post_id: String,
    ) -> AppResult<Option<Value>> {
        let root = root_for_generation(&self.graph, generation)?;
        let post = self
            .blocking(root.clone(), move |root| {
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
        self.download_media(root, generation, urls);
        Ok(Some(json!({"archive": post, "resources": resources})))
    }

    /// Command: the archived X posts whose media includes `asset_path`.
    pub async fn x_archive_owners(
        &self,
        asset_path: String,
        generation: Option<u64>,
    ) -> AppResult<Vec<String>> {
        let root = match generation {
            Some(generation) => root_for_generation(&self.graph, generation)?,
            None => current_root(&self.graph)?,
        };
        self.blocking(root, move |root| {
            if !asset_path.starts_with("assets/x/") {
                return Ok(vec![]);
            }
            let directory = resolve(&root, "assets/x")?;
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
}
