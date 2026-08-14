const COMMANDS: &[&str] = &["get_environment"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
