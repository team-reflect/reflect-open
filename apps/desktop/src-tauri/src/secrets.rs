//! Secrets in the OS keychain (Plan 10): the only place BYOK API keys live.
//!
//! Per the product principles, credentials never touch markdown, Git, or
//! `.reflect/`. Rust exposes the keychain as an opaque name → value store (a
//! capability); which names exist and what they hold is `@reflect/core`
//! policy (see `ai/secrets.ts`).

use keyring_core::{Entry, Error};

use crate::error::{AppError, AppResult};

/// The keychain service every Reflect secret is filed under.
const SERVICE: &str = "reflect-open";

/// Install this platform's native keychain as the default store.
pub fn init_store() -> keyring_core::Result<()> {
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new()?;
    #[cfg(target_os = "ios")]
    let store = apple_native_keyring_store::protected::Store::new()?;
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new()?;
    #[cfg(target_os = "linux")]
    let store = dbus_secret_service_keyring_store::Store::new()?;
    keyring_core::set_default_store(store);
    Ok(())
}

fn entry(name: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, name).map_err(|err| AppError::io(err.to_string()))
}

fn set_in(entry: &Entry, value: &str) -> AppResult<()> {
    entry
        .set_password(value)
        .map_err(|err| AppError::io(err.to_string()))
}

/// A missing entry is an expected state (key not configured yet), not an error.
fn get_from(entry: &Entry) -> AppResult<Option<String>> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::io(err.to_string())),
    }
}

/// Deleting a missing entry succeeds so the operation is idempotent
/// (retry-safe from the frontend).
fn delete_from(entry: &Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::io(err.to_string())),
    }
}

/// Keychain calls run on a blocking thread, never the main loop: macOS parks
/// `get_password` on a user-facing password prompt whenever the binary's code
/// signature doesn't match the item's ACL (every dev rebuild), and a sync
/// command would freeze the whole app — no paint, no notes — until the user
/// answers.
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| AppError::io(err.to_string()))?
}

/// Command: store `value` under `name`, replacing any prior value.
#[tauri::command]
pub async fn secret_set(name: String, value: String) -> AppResult<()> {
    run_blocking(move || set_in(&entry(&name)?, &value)).await
}

/// Command: the secret stored under `name`, or `None` when there isn't one.
#[tauri::command]
pub async fn secret_get(name: String) -> AppResult<Option<String>> {
    run_blocking(move || get_from(&entry(&name)?)).await
}

/// Command: remove the secret stored under `name`.
#[tauri::command]
pub async fn secret_delete(name: String) -> AppResult<()> {
    run_blocking(move || delete_from(&entry(&name)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    /// The default store is process-global, so install the mock once.
    fn use_mock_store() {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| {
            keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
        });
    }

    #[test]
    fn commands_round_trip_through_the_store() {
        use_mock_store();
        tauri::async_runtime::block_on(async {
            let name = || "ai-api-key:round-trip".to_string();

            assert_eq!(secret_get(name()).await.unwrap(), None);

            secret_set(name(), "sk-secret".into()).await.unwrap();
            assert_eq!(secret_get(name()).await.unwrap(), Some("sk-secret".into()));

            secret_set(name(), "sk-rotated".into()).await.unwrap();
            assert_eq!(secret_get(name()).await.unwrap(), Some("sk-rotated".into()));

            secret_delete(name()).await.unwrap();
            assert_eq!(secret_get(name()).await.unwrap(), None);
            secret_delete(name()).await.unwrap();
        });
    }

    #[test]
    fn store_failures_are_errors_not_missing_keys() {
        use_mock_store();
        let entry = entry("ai-api-key:failure").unwrap();
        let mock: &keyring_core::mock::Cred = entry.as_any().downcast_ref().unwrap();
        mock.set_error(Error::NoStorageAccess("locked".into()));
        assert!(get_from(&entry).is_err());
    }
}
