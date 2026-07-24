//! Early native crash/hang diagnostics for the iOS host process.

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CString};

const SENTRY_DSN_PREFIX: &str = "https://";
const SENTRY_ENDPOINT: &str = "o463484.ingest.us.sentry.io/4511705649971200";

fn parse_native_dsn(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let remainder = value.strip_prefix(SENTRY_DSN_PREFIX)?;
    let (public_key, endpoint) = remainder.split_once('@')?;
    if public_key.len() != 32
        || !public_key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || endpoint != SENTRY_ENDPOINT
    {
        return None;
    }
    Some(value)
}

fn parse_app_version(value: &str) -> Option<&str> {
    let value = value.trim();
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let mut core_parts = value[..core_end].split('.');
    let valid_core = (0..3).all(|_| {
        core_parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    }) && core_parts.next().is_none();
    let valid_suffix = core_end == value.len() || core_end + 1 < value.len();
    if value.len() > 64
        || !valid_core
        || !valid_suffix
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return None;
    }
    Some(value)
}

#[cfg(target_os = "ios")]
extern "C" {
    fn reflect_start_native_diagnostics(dsn: *const c_char, version: *const c_char);
}

/// Starts the native SDK when this official build carries the production DSN.
#[cfg(target_os = "ios")]
pub fn start(app_version: &str) {
    let Some(dsn) = parse_native_dsn(option_env!("VITE_SENTRY_DSN")) else {
        return;
    };
    let Some(app_version) = parse_app_version(app_version) else {
        return;
    };
    let Ok(dsn) = CString::new(dsn) else {
        return;
    };
    let Ok(app_version) = CString::new(app_version) else {
        return;
    };
    // SAFETY: the Swift function copies these valid, NUL-terminated UTF-8
    // strings during the call and never retains the pointers.
    unsafe {
        reflect_start_native_diagnostics(dsn.as_ptr(), app_version.as_ptr());
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_app_version, parse_native_dsn};

    #[test]
    fn accepts_only_the_production_reflect_project() {
        let valid =
            "https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200";
        assert_eq!(parse_native_dsn(Some(valid)), Some(valid));
        assert!(parse_native_dsn(Some("https://public@example.test/1")).is_none());
        assert!(parse_native_dsn(Some(
            "https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/1"
        ))
        .is_none());
        assert!(parse_native_dsn(None).is_none());
    }

    #[test]
    fn accepts_only_safe_release_versions() {
        assert_eq!(parse_app_version("0.7.0-beta.16"), Some("0.7.0-beta.16"));
        assert!(parse_app_version("../private/note").is_none());
        assert!(parse_app_version("privateNote").is_none());
        assert!(parse_app_version("").is_none());
    }
}
