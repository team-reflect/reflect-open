fn main() {
    println!("cargo:rerun-if-env-changed=VITE_SENTRY_DSN");
    tauri_build::build()
}
