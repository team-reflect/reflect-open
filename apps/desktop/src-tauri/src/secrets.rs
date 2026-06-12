//! Secrets in the OS keychain (Plan 10): the only place BYOK API keys live.
//!
//! Per the product principles, credentials never touch markdown, Git, or
//! `.reflect/`. Rust exposes the keychain as an opaque name → value store (a
//! capability); which names exist and what they hold is `@reflect/core`
//! policy (see `ai/secrets.ts`).

use keyring::Entry;

use crate::error::{AppError, AppResult};

/// The keychain service every Reflect secret is filed under.
const SERVICE: &str = "reflect-open";

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
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::io(err.to_string())),
    }
}

/// Deleting a missing entry succeeds so the operation is idempotent
/// (retry-safe from the frontend).
fn delete_from(entry: &Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
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

    /// The mock keystore scopes state to one `Entry` (no shared backing store),
    /// so the round trip is exercised on a single entry. What this asserts is
    /// the error mapping the frontend relies on: a missing entry reads as
    /// `None` (not an error) and delete is idempotent. The real cross-process
    /// persistence is the OS keychain's contract, not ours.
    #[test]
    fn keychain_round_trip_on_one_entry() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let entry = entry("ai-api-key:test").unwrap();

        assert_eq!(get_from(&entry).unwrap(), None);

        set_in(&entry, "sk-secret").unwrap();
        assert_eq!(get_from(&entry).unwrap(), Some("sk-secret".into()));

        set_in(&entry, "sk-rotated").unwrap();
        assert_eq!(get_from(&entry).unwrap(), Some("sk-rotated".into()));

        delete_from(&entry).unwrap();
        assert_eq!(get_from(&entry).unwrap(), None);

        // Idempotent: deleting again is fine.
        delete_from(&entry).unwrap();
    }

    /// The commands hop to a blocking thread (a parked keychain prompt must
    /// never stall the main loop); this exercises that plumbing end-to-end
    /// against the mock store.
    #[test]
    fn commands_resolve_through_the_blocking_hop() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        tauri::async_runtime::block_on(async {
            assert_eq!(secret_get("plumbing-test".into()).await.unwrap(), None);
            secret_delete("plumbing-test".into()).await.unwrap();
        });
    }
}
