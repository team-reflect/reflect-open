const COMMANDS: &[&str] = &["get_environment", "sync"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
