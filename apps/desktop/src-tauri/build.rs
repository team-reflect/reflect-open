fn main() {
    // `native_diagnostics` bakes the DSN in with `option_env!`, which cargo
    // does not otherwise track.
    println!("cargo:rerun-if-env-changed=VITE_SENTRY_DSN");
    tauri_build::build()
}
