import Foundation
import RecordingKit
import WebHostKit

/// The `plugin:recording` commands and events: the shell's face of
/// `RecordingEngine`. The engine lives as long as the app, so a recording
/// continues while the page reloads.
@MainActor
final class RecordingCapability {
  private let engine = RecordingEngine(stagingDirectory: {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("audio-memo-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  })

  /// `emit` delivers each engine event as `plugin:recording:<event>`.
  init(emit: @escaping @MainActor (String, Data) -> Void) {
    engine.log = { ReflectCore.log(.error, $0) }
    engine.onEvent = { event in
      let name: String
      let payload: any Encodable
      switch event {
      case .level(let level): (name, payload) = ("recordingLevel", level)
      case .segment(let segment): (name, payload) = ("recordingSegment", segment)
      case .stopped(let stopped): (name, payload) = ("recordingStopped", stopped)
      case .nativeAction(let action): (name, payload) = ("nativeAction", action)
      }
      guard let json = try? JSONEncoder().encode(payload) else { return }
      // The engine delivers its events on the main queue.
      MainActor.assumeIsolated {
        emit("plugin:recording:\(name)", json)
      }
    }
    engine.activate()
  }

  /// Asks the page to start a recording. The request waits in the engine
  /// until the page is ready for it.
  func requestRecording() {
    engine.queueAction("recordAudio")
  }

  var commands: [String: ShellCommand] {
    [
      "plugin:recording|start_recording": { [engine] request in
        struct Args: Decodable {
          struct Request: Decodable {
            var segmentMs: Double
            var reminderMs: Double
          }
          var request: Request
        }
        guard let args = request.decodeArgs(Args.self)?.request else {
          return .error(
            kind: "parse", message: "start_recording takes {request: {segmentMs, reminderMs}}")
        }
        return await Self.reply {
          engine.start(segmentMs: args.segmentMs, reminderMs: args.reminderMs, completion: $0)
        }
      },
      "plugin:recording|stop_recording": { [engine] _ in
        await Self.reply { engine.stop(completion: $0) }
      },
      "plugin:recording|cancel_recording": { [engine] _ in
        let result = await withCheckedContinuation {
          engine.cancel(completion: $0.resume(returning:))
        }
        if case .failure(let error) = result {
          return .error(kind: "io", message: error.message)
        }
        return .null
      },
      "plugin:recording|recording_status": { [engine] _ in .value(engine.status()) },
      "plugin:recording|list_staged": { [engine] _ in
        do {
          return .value(ListStagedResponse(files: try engine.listStaged()))
        } catch {
          return .error(
            kind: "io",
            message: "listing staged recordings failed: \(error.localizedDescription)")
        }
      },
      "plugin:recording|delete_staged": { [engine] request in
        struct Args: Decodable {
          struct Request: Decodable {
            var path: String
          }
          var request: Request
        }
        guard let path = request.decodeArgs(Args.self)?.request.path else {
          return .error(kind: "parse", message: "delete_staged takes {request: {path}}")
        }
        do {
          try engine.deleteStaged(path: path)
          return .null
        } catch {
          return .error(
            kind: "io",
            message: "deleting staged recording failed: \(error.localizedDescription)")
        }
      },
      "plugin:recording|actions_ready": { [engine] _ in
        engine.actionsReady()
        return .null
      },
      "plugin:recording|action_performed": { [engine] _ in
        engine.actionPerformed()
        return .null
      },
    ]
  }

  /// Runs an engine call that ends with a completion, and answers its result.
  private static func reply<Response: Encodable>(
    _ call: (@escaping (Result<Response, RecordingError>) -> Void) -> Void
  ) async -> CoreReply {
    let result = await withCheckedContinuation { continuation in
      call { continuation.resume(returning: $0) }
    }
    switch result {
    case .success(let response): return .value(response)
    case .failure(let error): return .error(kind: "io", message: error.message)
    }
  }
}
