// `registerListener`/`remove_listener` are the built-in event-channel
// commands `@tauri-apps/api`'s `addPluginListener` invokes (those exact
// spellings); they must be in COMMANDS for the ACL to allow them.
const COMMANDS: &[&str] = &[
    "current_height",
    "impact_light",
    "registerListener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
