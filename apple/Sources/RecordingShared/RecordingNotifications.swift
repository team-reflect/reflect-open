public import Foundation

/// The bridge from OS entry points in the app target (Siri App Intents, the
/// Live Activity's stop button, the home-screen quick action) to the recording
/// engine in `tauri-plugin-recording`. They run in one process but in
/// different modules, so they talk through `NotificationCenter`.
extension Notification.Name {
  public static let recordingStartRequested = Notification.Name(
    "app.reflect.recording.start-requested")
  public static let recordingStopRequested = Notification.Name(
    "app.reflect.recording.stop-requested")
}
