const COMMANDS: &[&str] = &[
    "get_environment",
    "sync",
    "present_offer_code_redeem_sheet",
    "request_review",
];

fn main() {
    // swift-rs watches only the plugin's own ios/ dir; rebuild on apple/ too.
    println!("cargo:rerun-if-changed=../../apple/Package.swift");
    println!("cargo:rerun-if-changed=../../apple/Sources");
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
