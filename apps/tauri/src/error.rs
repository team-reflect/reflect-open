//! The shared error contract returned by every `#[tauri::command]`, defined
//! in `reflect-types` so the other crates return the same `{ kind, message }`.

pub use reflect_types::{AppError, AppResult};
