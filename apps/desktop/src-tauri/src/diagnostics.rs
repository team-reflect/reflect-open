//! Process facts for the support diagnostics report.

use std::sync::LazyLock;
use std::time::Instant;

static STARTED: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Starts the uptime clock. Call once, as early as possible in `run`.
pub fn mark_start() {
    LazyLock::force(&STARTED);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDiagnostics {
    /// The physical footprint of this process (what Activity Monitor shows as
    /// Memory); `None` where the platform has no such number.
    pub footprint_bytes: Option<u64>,
    pub uptime_ms: u64,
    pub os: &'static str,
    pub os_version: Option<String>,
    pub arch: &'static str,
}

/// Command: memory, uptime, and OS facts of this process.
#[tauri::command]
pub fn process_diagnostics() -> ProcessDiagnostics {
    ProcessDiagnostics {
        footprint_bytes: footprint_bytes(),
        uptime_ms: u64::try_from(STARTED.elapsed().as_millis()).unwrap_or(u64::MAX),
        os: std::env::consts::OS,
        os_version: os_version(),
        arch: std::env::consts::ARCH,
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn footprint_bytes() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: `info` is a valid, writable `rusage_info_v4`, which is what the
    // `RUSAGE_INFO_V4` flavor fills.
    let status = unsafe {
        libc::proc_pid_rusage(
            std::process::id().cast_signed(),
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr().cast(),
        )
    };
    // SAFETY: a zero status means the call filled the struct.
    (status == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn footprint_bytes() -> Option<u64> {
    None
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn os_version() -> Option<String> {
    let mut buffer = [0u8; 64];
    let mut length = buffer.len();
    // SAFETY: the name is NUL-terminated, and `length` holds the size of the
    // writable `buffer`.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &raw mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    let bytes = buffer.get(..length)?;
    let text = std::str::from_utf8(bytes).ok()?.trim_end_matches('\0');
    Some(text.to_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn os_version() -> Option<String> {
    None
}

#[cfg(all(test, any(target_os = "macos", target_os = "ios")))]
mod tests {
    use super::process_diagnostics;

    #[test]
    fn reports_a_footprint_and_os_version() {
        let diagnostics = process_diagnostics();
        assert!(diagnostics.footprint_bytes.is_some_and(|bytes| bytes > 0));
        let version = diagnostics.os_version.unwrap();
        assert!(
            version.split('.').all(|part| part.parse::<u32>().is_ok()),
            "{version}"
        );
    }
}
