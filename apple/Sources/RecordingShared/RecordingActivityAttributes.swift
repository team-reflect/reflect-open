#if os(iOS)
public import ActivityKit
public import Foundation

/// The recording Live Activity's shape, shared between the app (the
/// recording plugin starts/ends the activity) and the widget extension
/// (which renders it). ActivityKit matches the two sides by this type's
/// name, so both binaries link this one module. Keep it free of plugin
/// imports.
@available(iOS 16.1, *)
public struct RecordingActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// When recording started — the lock-screen timer counts up from it.
    public var startedAt: Date

    public init(startedAt: Date) {
      self.startedAt = startedAt
    }
  }

  public init() {}
}
#endif
