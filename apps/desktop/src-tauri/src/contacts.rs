//! Apple Contacts commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::contacts::{ContactMatch, ContactsAuthorization};
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn contacts_authorization_status(
    core: State<'_, Arc<Core>>,
) -> AppResult<ContactsAuthorization> {
    core.contacts_authorization_status().await
}

#[tauri::command]
pub async fn contacts_request_access(core: State<'_, Arc<Core>>) -> AppResult<bool> {
    core.contacts_request_access().await
}

#[tauri::command]
pub async fn contacts_lookup_by_email(
    email: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<ContactMatch>> {
    core.contacts_lookup_by_email(email).await
}

#[tauri::command]
pub async fn contacts_lookup_by_name(
    name: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<ContactMatch>> {
    core.contacts_lookup_by_name(name).await
}
