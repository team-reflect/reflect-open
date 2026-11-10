const COMMANDS: &[&str] = &[
    "get_environment",
    "sync",
    "present_offer_code_redeem_sheet",
    "request_review",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
