const COMMANDS: &[&str] = &["impact_light"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
