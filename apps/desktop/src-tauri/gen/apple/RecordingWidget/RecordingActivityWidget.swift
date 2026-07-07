import ActivityKit
import SwiftUI
import WidgetKit

/// The recording Live Activity (V1's `RecordingActivityWidget`, rebuilt):
/// lock-screen banner + Dynamic Island showing a live elapsed timer while a
/// memo records, with a stop button on iOS 17+ (a `LiveActivityIntent` that
/// performs in the app's process — see `StopRecordingLiveActivityIntent.swift`,
/// compiled into both targets). The timer renders from `startedAt` with no
/// updates needed; the recording plugin starts and ends the activity.
struct RecordingActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
      HStack(spacing: 12) {
        Image(systemName: "mic.fill")
          .font(.title3)
          .foregroundStyle(.red)
        VStack(alignment: .leading, spacing: 2) {
          Text("Recording")
            .font(.headline)
          Text("Reflect")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        RecordingTimerText(startedAt: context.state.startedAt)
          .font(.title3.monospacedDigit())
        StopRecordingButton()
      }
      .padding()
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: "mic.fill")
            .font(.title2)
            .foregroundStyle(.red)
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(spacing: 2) {
            Text("Recording")
              .font(.headline)
            RecordingTimerText(startedAt: context.state.startedAt)
              .font(.title3.monospacedDigit())
              .frame(maxWidth: 80)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          StopRecordingButton()
        }
      } compactLeading: {
        Image(systemName: "mic.fill")
          .foregroundStyle(.red)
      } compactTrailing: {
        RecordingTimerText(startedAt: context.state.startedAt)
          .font(.caption.monospacedDigit())
          .frame(width: 44)
      } minimal: {
        Image(systemName: "mic.fill")
          .foregroundStyle(.red)
      }
    }
  }
}

/// The counting-up elapsed display — self-updating, so the activity never
/// needs a content refresh while recording.
private struct RecordingTimerText: View {
  let startedAt: Date

  var body: some View {
    Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
      .multilineTextAlignment(.trailing)
  }
}

/// The stop control: iOS 17 can run a `LiveActivityIntent` straight from the
/// lock screen; earlier versions get no button (V1 parity — tapping the
/// activity opens the app, where the drawer's stop lives).
private struct StopRecordingButton: View {
  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: StopRecordingIntent()) {
        Image(systemName: "stop.fill")
          .font(.title3)
          .foregroundStyle(.red)
          .padding(8)
      }
      .buttonStyle(.plain)
    }
  }
}
