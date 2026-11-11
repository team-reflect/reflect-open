/// Called once from `main.mm` before Tauri boots, so crashes during Tauri
/// initialization are already covered.
@_cdecl("reflect_start_native_diagnostics")
public func reflectStartNativeDiagnostics() {
  #if !DEBUG
  NativeDiagnostics.start(runtime: "tauri-native")
  #endif
}
