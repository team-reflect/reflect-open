import Foundation

#if canImport(AppIntents)
  import AppIntents

  /// The Live Activity's stop button (audio-memos wave 3). A
  /// `LiveActivityIntent` performs in the app's process without foregrounding
  /// it, so the lock screen can end a memo directly; the recording plugin
  /// observes the notification and finalizes the file natively (reason
  /// `remote`), and ingest follows the usual staged-file paths.
  ///
  /// Compiled into BOTH the app target (execution) and the widget extension
  /// (the button references the type) — the standard shared-source pattern.
  /// The notification name mirrors `RecordingPlugin.stopRequestedNotification`.
  @available(iOS 17.0, *)
  struct StopRecordingIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop recording"

    @MainActor
    func perform() async throws -> some IntentResult {
      NotificationCenter.default.post(
        name: Notification.Name("app.reflect.recording.stop-requested"), object: nil)
      return .result()
    }
  }
#endif
