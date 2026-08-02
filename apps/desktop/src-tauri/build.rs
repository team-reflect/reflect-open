fn main() {
    // `native_diagnostics` bakes the DSN in with `option_env!`, which cargo
    // does not otherwise track.
    println!("cargo:rerun-if-env-changed=VITE_SENTRY_DSN");

    // iOS: `native_diagnostics` calls `reflect_start_native_diagnostics`, a
    // symbol Xcode emits from `NativeDiagnostics.swift` (`@_cdecl`) when it
    // links the final app binary - after cargo has already built this crate.
    // The iOS build consumes the `staticlib` (`libapp.a`), which tolerates the
    // unresolved reference; cargo also builds the `cdylib`, which does not, and
    // the cdylib link fails before Xcode ever runs. Let the cdylib defer the
    // symbol to load time (`-undefined dynamic_lookup`); the cdylib is not
    // shipped on iOS, so this only unblocks the cargo step.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }

    tauri_build::build()
}
