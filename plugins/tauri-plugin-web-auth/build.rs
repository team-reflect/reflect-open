const COMMANDS: &[&str] = &["start"];

fn main() {
    // swift-rs watches only this crate's ios/ directory; the Swift package
    // also depends on the repo's apple/ package.
    println!("cargo:rerun-if-changed=../../apple/Package.swift");
    println!("cargo:rerun-if-changed=../../apple/Sources");
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
