//! iCloud conflict sweep command, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::icloud::sweep::{SweepOutcome, SweepScope};
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn icloud_conflicts_scan(
    generation: u64,
    skip_paths: Vec<String>,
    ingested_paths: Vec<String>,
    record_baseline: bool,
    scope: SweepScope,
    core: State<'_, Arc<Core>>,
) -> AppResult<SweepOutcome> {
    core.icloud_conflicts_scan(
        generation,
        skip_paths,
        ingested_paths,
        record_baseline,
        scope,
    )
    .await
}
