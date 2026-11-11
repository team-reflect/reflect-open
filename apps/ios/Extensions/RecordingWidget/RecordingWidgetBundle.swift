import SwiftUI
import WidgetKit

/// The widget extension's entry point (audio-memos wave 3): the lock-screen /
/// home-screen "record" widget plus the recording Live Activity. Swift only —
/// no Rust, no webview; both surfaces hand off to the main app (the widget
/// through `reflect://record-audio`, the activity's stop button through an
/// in-process `LiveActivityIntent`).
@main
struct ReflectWidgetBundle: WidgetBundle {
  var body: some Widget {
    RecordAudioWidget()
    RecordingActivityWidget()
  }
}
