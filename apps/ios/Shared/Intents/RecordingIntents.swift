import Foundation
import RecordingShared

#if canImport(AppIntents)
import AppIntents

/// Siri / Shortcuts entry points for audio memos (audio-memos wave 3,
/// V1 parity: "Start recording in Reflect").
///
/// These compile into the app target, so `perform()` runs in the app's own
/// process — but in a different module from the host of the recording
/// engine (the Swift shell's capability). They talk to
/// it through NotificationCenter (`RecordingNotifications.swift` in
/// `RecordingShared`). Starting goes through the engine's persisted action
/// queue (the webview must present recording UI); stopping is finalized
/// natively at once.
struct StartRecordingIntent: AppIntent {
  static let title: LocalizedStringResource = "Start recording"
  static let description = IntentDescription(
    "Start recording an audio memo that Reflect transcribes into your daily note.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(
      name: .recordingStartRequested, object: nil)
    return .result()
  }
}

struct StopRecordingSiriIntent: AppIntent {
  static let title: LocalizedStringResource = "Stop recording"
  static let description = IntentDescription("Stop the audio memo Reflect is recording.")
  static let openAppWhenRun = false

  @MainActor
  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(
      name: .recordingStopRequested, object: nil)
    return .result()
  }
}

struct ReflectAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartRecordingIntent(),
      phrases: [
        "Start recording in \(.applicationName)",
        "Record an audio memo in \(.applicationName)",
      ],
      shortTitle: "Record audio",
      systemImageName: "mic"
    )
    AppShortcut(
      intent: StopRecordingSiriIntent(),
      phrases: ["Stop recording in \(.applicationName)"],
      shortTitle: "Stop recording",
      systemImageName: "stop.circle"
    )
    AppShortcut(
      intent: QuickNoteIntent(),
      phrases: [
        "Add a note in \(.applicationName)",
        "Take a quick note in \(.applicationName)",
      ],
      shortTitle: "Quick note",
      systemImageName: "square.and.pencil"
    )
  }
}
#endif
