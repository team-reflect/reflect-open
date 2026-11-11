//! The git backup/sync commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_git::{
    CommitOutcome, GitCredential, GitStatus, PullOutcome, PushOutcome, RemoteDelta, RemoteTip,
};
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn git_status(generation: u64, core: State<'_, Arc<Core>>) -> AppResult<GitStatus> {
    core.git_status(generation).await
}

#[tauri::command]
pub async fn git_setup(
    remote_url: Option<String>,
    branch: Option<String>,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<GitStatus> {
    core.git_setup(remote_url, branch, generation).await
}

#[tauri::command]
pub async fn git_disconnect(generation: u64, core: State<'_, Arc<Core>>) -> AppResult<GitStatus> {
    core.git_disconnect(generation).await
}

#[tauri::command]
pub async fn git_clone(
    url: String,
    path: String,
    credential: Option<GitCredential>,
    core: State<'_, Arc<Core>>,
) -> AppResult<()> {
    core.git_clone(url, path, credential).await
}

#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<CommitOutcome> {
    core.git_commit_all(message, generation).await
}

#[tauri::command]
pub async fn git_fetch(
    credential: Option<GitCredential>,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<RemoteDelta> {
    core.git_fetch(credential, generation).await
}

#[tauri::command]
pub async fn git_remote_head(
    url: Option<String>,
    credential: Option<GitCredential>,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<RemoteTip> {
    core.git_remote_head(url, credential, generation).await
}

#[tauri::command]
pub async fn git_pull(
    message: String,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<PullOutcome> {
    core.git_pull(message, generation).await
}

#[tauri::command]
pub async fn git_push(
    credential: Option<GitCredential>,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<PushOutcome> {
    core.git_push(credential, generation).await
}
