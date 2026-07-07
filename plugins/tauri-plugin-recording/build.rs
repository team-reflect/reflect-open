// `registerListener`/`remove_listener` are the built-in event-channel
// commands `@tauri-apps/api`'s `addPluginListener` invokes (those exact
// spellings); they must be in COMMANDS for the ACL to allow them.
const COMMANDS: &[&str] = &[
    "start_recording",
    "stop_recording",
    "cancel_recording",
    "recording_status",
    "actions_ready",
    "action_performed",
    "list_staged",
    "read_staged",
    "delete_staged",
    "registerListener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
