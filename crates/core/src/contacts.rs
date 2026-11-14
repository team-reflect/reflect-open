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

use reflect_types::{AppResult, ContactMatch, ContactsAuthorization};

use crate::Core;

impl Core {
    /// Command: the current Contacts permission state. Never prompts.
    pub async fn contacts_authorization_status(&self) -> AppResult<ContactsAuthorization> {
        self.spawn_blocking(|| Ok(platform::authorization_status()))
            .await
    }
}

impl Core {
    /// Command: trigger the OS permission prompt (a no-op once the user has
    /// decided) and report whether access is granted.
    pub async fn contacts_request_access(&self) -> AppResult<bool> {
        self.spawn_blocking(platform::request_access).await
    }
}

impl Core {
    /// Command: unified contacts with an email address matching `email`.
    pub async fn contacts_lookup_by_email(&self, email: String) -> AppResult<Vec<ContactMatch>> {
        self.spawn_blocking(move || platform::lookup_by_email(&email))
            .await
    }
}

impl Core {
    /// Command: unified contacts matching `name`, using the framework's own name
    /// matching (case- and diacritic-insensitive, word-prefix based). Exact-match
    /// policy is applied in `@reflect/core`, not here.
    pub async fn contacts_lookup_by_name(&self, name: String) -> AppResult<Vec<ContactMatch>> {
        self.spawn_blocking(move || platform::lookup_by_name(&name))
            .await
    }
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

    use reflect_types::{AppError, AppResult, ContactMatch, ContactsAuthorization};

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
    use reflect_types::{AppError, AppResult};

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
