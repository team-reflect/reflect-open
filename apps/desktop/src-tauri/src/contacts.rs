//! Apple Contacts capability: live `CNContactStore` reads, nothing persisted.
//!
//! Rust owns the primitive only — authorization and on-demand lookups by
//! email or name. Which note titles count as person-like, and what contact
//! details get written into a note, is `@reflect/core` policy. The address
//! book is never mirrored into `.reflect/index.sqlite` (the index stays a
//! pure projection of markdown), and Reflect never writes back to Contacts.
//!
//! On platforms without the Contacts framework (Windows, Linux, Android) the
//! status command answers [`ContactsAuthorization::Unavailable`] so the
//! frontend can hide the integration; the other commands fail loudly.

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// The Contacts permission state, as the settings UI consumes it.
///
/// Every variant is part of the wire contract even when the compile target
/// can't construct it (`Unavailable` only exists off-Apple, `Limited` only
/// on-device) — hence the `dead_code` allowance.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContactsAuthorization {
    /// The user has not been asked yet — enabling the toggle should prompt.
    NotDetermined,
    /// Access is blocked by policy (parental controls, MDM); the user cannot
    /// grant it from the app.
    Restricted,
    /// The user said no — point them at System Settings.
    Denied,
    /// Full access granted.
    Authorized,
    /// Partial access (iOS 18+); reads work against the shared subset.
    Limited,
    /// No Contacts framework on this platform.
    Unavailable,
}

/// One matched contact, flattened to the fields Reflect can write into a
/// note as markdown. Photos are deliberately absent (out of v1 scope).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMatch {
    /// Locale-aware display name from `CNContactFormatter` (given/family
    /// ordering differs by locale, so it is not composed by hand).
    pub full_name: String,
    pub given_name: String,
    pub family_name: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
}

/// Contacts calls run on a blocking thread, never the main loop: the first
/// access parks on the TCC permission prompt until the user answers, and
/// store fetches are synchronous framework work.
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| AppError::io(err.to_string()))?
}

/// Command: the current Contacts permission state. Never prompts.
#[tauri::command]
pub async fn contacts_authorization_status() -> AppResult<ContactsAuthorization> {
    run_blocking(|| Ok(platform::authorization_status())).await
}

/// Command: trigger the OS permission prompt (a no-op once the user has
/// decided) and report whether access is granted.
#[tauri::command]
pub async fn contacts_request_access() -> AppResult<bool> {
    run_blocking(platform::request_access).await
}

/// Command: unified contacts with an email address matching `email`.
#[tauri::command]
pub async fn contacts_lookup_by_email(email: String) -> AppResult<Vec<ContactMatch>> {
    run_blocking(move || platform::lookup_by_email(&email)).await
}

/// Command: unified contacts matching `name`, using the framework's own name
/// matching (case- and diacritic-insensitive, word-prefix based). Exact-match
/// policy is applied in `@reflect/core`, not here.
#[tauri::command]
pub async fn contacts_lookup_by_name(name: String) -> AppResult<Vec<ContactMatch>> {
    run_blocking(move || platform::lookup_by_name(&name)).await
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2_contacts::{
        CNAuthorizationStatus, CNContact, CNContactEmailAddressesKey, CNContactFamilyNameKey,
        CNContactFormatter, CNContactFormatterStyle, CNContactGivenNameKey,
        CNContactPhoneNumbersKey, CNContactStore, CNEntityType, CNKeyDescriptor,
    };
    use objc2_foundation::{NSArray, NSError, NSPredicate, NSString};

    use super::{ContactMatch, ContactsAuthorization};
    use crate::error::{AppError, AppResult};

    pub fn authorization_status() -> ContactsAuthorization {
        let status =
            unsafe { CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts) };
        match status {
            CNAuthorizationStatus::NotDetermined => ContactsAuthorization::NotDetermined,
            CNAuthorizationStatus::Restricted => ContactsAuthorization::Restricted,
            CNAuthorizationStatus::Denied => ContactsAuthorization::Denied,
            CNAuthorizationStatus::Authorized => ContactsAuthorization::Authorized,
            CNAuthorizationStatus::Limited => ContactsAuthorization::Limited,
            // Future framework values surface as Restricted — "not usable,
            // fix in System Settings" — rather than silently authorized.
            _ => ContactsAuthorization::Restricted,
        }
    }

    pub fn request_access() -> AppResult<bool> {
        let store = unsafe { CNContactStore::new() };
        let (sender, receiver) = std::sync::mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = sender.send(granted.as_bool());
        });
        unsafe {
            store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &handler)
        };
        // Generous bound: the prompt waits on the user, but a handler that
        // never fires (XPC hiccup) must not park this blocking-pool thread
        // forever. A late answer after the timeout is dropped harmlessly.
        receiver
            .recv_timeout(std::time::Duration::from_secs(300))
            .map_err(|_| AppError::io("Contacts permission prompt did not complete"))
    }

    pub fn lookup_by_email(email: &str) -> AppResult<Vec<ContactMatch>> {
        let predicate = unsafe {
            CNContact::predicateForContactsMatchingEmailAddress(&NSString::from_str(email))
        };
        fetch(&predicate)
    }

    pub fn lookup_by_name(name: &str) -> AppResult<Vec<ContactMatch>> {
        let predicate =
            unsafe { CNContact::predicateForContactsMatchingName(&NSString::from_str(name)) };
        fetch(&predicate)
    }

    fn fetch(predicate: &NSPredicate) -> AppResult<Vec<ContactMatch>> {
        let store = unsafe { CNContactStore::new() };
        let keys = keys_to_fetch();
        let contacts =
            unsafe { store.unifiedContactsMatchingPredicate_keysToFetch_error(predicate, &keys) }
                .map_err(|err| AppError::io(err.localizedDescription().to_string()))?;
        Ok(contacts.iter().map(|contact| to_match(&contact)).collect())
    }

    fn keys_to_fetch() -> Retained<NSArray<ProtocolObject<dyn CNKeyDescriptor>>> {
        // The formatter declares its own required keys for the locale-aware
        // full name; the plain string keys cover the fields read directly.
        let formatter_keys = unsafe {
            CNContactFormatter::descriptorForRequiredKeysForStyle(CNContactFormatterStyle::FullName)
        };
        let string_keys: [&NSString; 4] = unsafe {
            [
                CNContactGivenNameKey,
                CNContactFamilyNameKey,
                CNContactEmailAddressesKey,
                CNContactPhoneNumbersKey,
            ]
        };
        let mut keys: Vec<&ProtocolObject<dyn CNKeyDescriptor>> = string_keys
            .into_iter()
            .map(ProtocolObject::from_ref)
            .collect();
        keys.push(&formatter_keys);
        NSArray::from_slice(&keys)
    }

    fn to_match(contact: &CNContact) -> ContactMatch {
        let full_name = unsafe {
            CNContactFormatter::stringFromContact_style(contact, CNContactFormatterStyle::FullName)
        }
        .map(|name| name.to_string())
        .unwrap_or_default();
        let given_name = unsafe { contact.givenName() }.to_string();
        let family_name = unsafe { contact.familyName() }.to_string();
        let emails = unsafe { contact.emailAddresses() }
            .iter()
            .map(|labeled| unsafe { labeled.value() }.to_string())
            .collect();
        let phones = unsafe { contact.phoneNumbers() }
            .iter()
            .map(|labeled| unsafe { labeled.value().stringValue() }.to_string())
            .collect();
        ContactMatch {
            full_name,
            given_name,
            family_name,
            emails,
            phones,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    use super::{ContactMatch, ContactsAuthorization};
    use crate::error::{AppError, AppResult};

    fn unavailable<T>() -> AppResult<T> {
        Err(AppError::Unknown {
            message: "Apple Contacts is only available on macOS and iOS".into(),
        })
    }

    pub fn authorization_status() -> ContactsAuthorization {
        ContactsAuthorization::Unavailable
    }

    pub fn request_access() -> AppResult<bool> {
        unavailable()
    }

    pub fn lookup_by_email(_email: &str) -> AppResult<Vec<ContactMatch>> {
        unavailable()
    }

    pub fn lookup_by_name(_name: &str) -> AppResult<Vec<ContactMatch>> {
        unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract the zod schemas in `@reflect/core` parse against:
    /// camelCase variants and camelCase DTO fields.
    #[test]
    fn authorization_serializes_to_camel_case() {
        let cases = [
            (ContactsAuthorization::NotDetermined, "\"notDetermined\""),
            (ContactsAuthorization::Restricted, "\"restricted\""),
            (ContactsAuthorization::Denied, "\"denied\""),
            (ContactsAuthorization::Authorized, "\"authorized\""),
            (ContactsAuthorization::Limited, "\"limited\""),
            (ContactsAuthorization::Unavailable, "\"unavailable\""),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        }
    }

    #[test]
    fn contact_match_serializes_to_camel_case() {
        let contact = ContactMatch {
            full_name: "Ada Lovelace".into(),
            given_name: "Ada".into(),
            family_name: "Lovelace".into(),
            emails: vec!["ada@example.com".into()],
            phones: vec!["+1 555 0100".into()],
        };
        let json = serde_json::to_value(&contact).unwrap();
        assert_eq!(json["fullName"], "Ada Lovelace");
        assert_eq!(json["givenName"], "Ada");
        assert_eq!(json["familyName"], "Lovelace");
        assert_eq!(json["emails"][0], "ada@example.com");
        assert_eq!(json["phones"][0], "+1 555 0100");
    }
}
