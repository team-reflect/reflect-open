import Foundation

#if canImport(ActivityKit)
  import ActivityKit

  /// The recording Live Activity's shape, shared between the app (the
  /// recording plugin starts/ends the activity) and the widget extension
  /// (which renders it). ActivityKit matches the two sides by this type's
  /// name, so the SAME FILE is compiled into both targets — the widget
  /// target references it by path in `gen/apple/project.yml`. Keep it free
  /// of plugin imports.
  @available(iOS 16.1, *)
  struct RecordingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
      /// When recording started — the lock-screen timer counts up from it.
      var startedAt: Date
    }
  }
#endif
