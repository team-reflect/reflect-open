import SwiftUI
import WidgetKit

/// One static, dateless entry — the widget is a button, not a data view.
struct RecordEntry: TimelineEntry {
  let date: Date
}

struct RecordProvider: TimelineProvider {
  func placeholder(in context: Context) -> RecordEntry {
    RecordEntry(date: .now)
  }

  func getSnapshot(in context: Context, completion: @escaping (RecordEntry) -> Void) {
    completion(RecordEntry(date: .now))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<RecordEntry>) -> Void) {
    completion(Timeline(entries: [RecordEntry(date: .now)], policy: .never))
  }
}

/// The "start an audio memo" widget (V1's lock-screen widget, rebuilt beside
/// the Tauri shell): tapping opens the app through `reflect://record-audio`,
/// which the Rust shell hands to the recording plugin's persisted action
/// queue — recording starts once the webview is ready, and the request
/// survives cold starts and webview crashes (the V1 handshake).
struct RecordAudioWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "app.reflect.record-audio", provider: RecordProvider()) { _ in
      RecordAudioWidgetView()
        .widgetURL(URL(string: "reflect://record-audio"))
        .widgetBackgroundCompat()
    }
    .configurationDisplayName("Record audio memo")
    .description("Start recording an audio memo in Reflect.")
    .supportedFamilies([.accessoryCircular, .systemSmall])
  }
}

struct RecordAudioWidgetView: View {
  @Environment(\.widgetFamily) private var family

  var body: some View {
    switch family {
    case .accessoryCircular:
      // Lock-screen circular: glyph only, system-tinted like Voice Memos'.
      ZStack {
        AccessoryWidgetBackground()
        Image(systemName: "mic.fill")
          .font(.title3)
      }
    default:
      VStack(spacing: 8) {
        Image(systemName: "mic.fill")
          .font(.largeTitle)
          .foregroundStyle(.red)
        Text("Record audio")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }
}

extension View {
  /// iOS 17 requires `containerBackground` on widget views (older widgets
  /// render an adoption error); the deployment target is 16.2, so apply it
  /// conditionally.
  @ViewBuilder
  func widgetBackgroundCompat() -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(.background, for: .widget)
    } else {
      self
    }
  }
}
