//! Starts native crash/hang reporting for the iOS host process.
//!
//! The Swift half lives in
//! `gen/apple/Sources/reflect-open/NativeDiagnostics.swift`; this module only
//! validates the compile-time DSN and hands it across the FFI boundary.

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CString};

const SENTRY_DSN_PREFIX: &str = "https://";
const SENTRY_ENDPOINT: &str = "o463484.ingest.us.sentry.io/4511705649971200";

/// Accept only the production Reflect project DSN. Forks and local builds
/// without the secret simply never start the native SDK.
///
/// The org/project identity is asserted in three places that must rotate
/// together: here, `parseExceptionTelemetryDsn` in
/// `src/lib/exception-telemetry.ts` (WebView SDK), and `isProductionSentryDsn`
/// in `scripts/release-ios.mjs` (symbol upload).
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
    let (Ok(dsn), Ok(app_version)) = (CString::new(dsn), CString::new(app_version)) else {
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
    use super::parse_native_dsn;

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
        assert!(parse_native_dsn(Some(
            "http://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200"
        ))
        .is_none());
        assert!(parse_native_dsn(None).is_none());
    }
}
