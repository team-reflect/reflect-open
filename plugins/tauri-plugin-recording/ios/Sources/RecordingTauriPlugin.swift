import Foundation
import RecordingKit
import Tauri
import WebKit

struct QueueActionArgs: Decodable {
  let action: String
}

struct StartArgs: Decodable {
  /// Rotate the recorder after this much audio; each segment lands as its own
  /// complete `.m4a`, so a session has no length limit.
  let segmentMs: Double
  /// Remind the user this often while the session runs.
  let reminderMs: Double
}

struct StagedPathArgs: Decodable {
  let path: String
}

/// The Tauri face of `RecordingEngine`: each command hops onto the main queue,
/// calls the engine, and settles its invoke; engine events become plugin
/// events.
class RecordingPlugin: Plugin {
  private let engine = RecordingEngine(stagingDirectory: {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("audio-memo-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  })

  @objc public override func load(webview: WKWebView) {
    engine.log = { Logger.error($0) }
    engine.onEvent = { [weak self] event in
      self?.forward(event)
    }
    engine.activate()
  }

  private func forward(_ event: RecordingEvent) {
    let name: String
    let data: any Encodable
    switch event {
    case .level(let level): (name, data) = ("recordingLevel", level)
    case .segment(let segment): (name, data) = ("recordingSegment", segment)
    case .stopped(let stopped): (name, data) = ("recordingStopped", stopped)
    case .nativeAction(let action): (name, data) = ("nativeAction", action)
    }
    do {
      try trigger(name, data: data)
    } catch {
      Logger.error("\(name) event failed to serialize: \(error)")
    }
  }

  // MARK: - Commands

  @objc public func startRecording(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartArgs.self)
    DispatchQueue.main.async {
      self.engine.start(segmentMs: args.segmentMs, reminderMs: args.reminderMs) { result in
        switch result {
        case .success(let response): invoke.resolve(response)
        case .failure(let error): invoke.reject(error.message)
        }
      }
    }
  }

  @objc public func stopRecording(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.engine.stop { result in
        switch result {
        case .success(let response): invoke.resolve(response)
        case .failure(let error): invoke.reject(error.message)
        }
      }
    }
  }

  @objc public func cancelRecording(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.engine.cancel { result in
        switch result {
        case .success: invoke.resolve()
        case .failure(let error): invoke.reject(error.message)
        }
      }
    }
  }

  @objc public func recordingStatus(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(self.engine.status())
    }
  }

  @objc public func listStaged(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        invoke.resolve(ListStagedResponse(files: try self.engine.listStaged()))
      } catch {
        invoke.reject("listing staged recordings failed: \(error.localizedDescription)")
      }
    }
  }

  @objc public func deleteStaged(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StagedPathArgs.self)
    DispatchQueue.main.async {
      do {
        try self.engine.deleteStaged(path: args.path)
        invoke.resolve()
      } catch {
        invoke.reject("deleting staged recording failed: \(error.localizedDescription)")
      }
    }
  }

  // MARK: - Native actions

  @objc public func actionsReady(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.engine.actionsReady()
      invoke.resolve()
    }
  }

  @objc public func actionPerformed(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.engine.actionPerformed()
      invoke.resolve()
    }
  }

  @objc public func queueAction(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(QueueActionArgs.self)
    DispatchQueue.main.async {
      self.engine.queueAction(args.action)
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_recording")
public func initPlugin() -> Plugin {
  return RecordingPlugin()
}
