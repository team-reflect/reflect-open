import Foundation
import ReflectCoreFFI
import WebHostKit

/// The directories and user agent that the Rust core starts with.
struct CoreConfig: Encodable, Sendable {
  var documentDir: String
  var dataDir: String
  var userAgent: String
}

/// One event that the core emitted: a name and a JSON payload.
struct CoreEvent: Sendable, Equatable {
  var name: String
  var payload: Data
}

/// The error of a core that did not start: the core's `{kind, message}` JSON.
struct CoreStartError: Error, CustomStringConvertible {
  var description: String
}

/// The Rust core behind the C interface of `reflect_core.h`. Commands run on
/// Rust threads; `dispatch` suspends until the reply arrives. Releasing the
/// last reference frees the core and ends `events`.
final class ReflectCore: Sendable {
  /// The events of the core, in the order it emitted them.
  let events: AsyncStream<CoreEvent>

  // `OpaquePointer` is not `Sendable`; the C interface accepts calls from any thread.
  private nonisolated(unsafe) let handle: OpaquePointer
  private let callbacks: Unmanaged<CoreCallbacks>

  /// Starts a core. `openURL` receives each URL or absolute file path that a
  /// command opens with the system handler, on a Rust thread, and returns
  /// whether it accepted it.
  init(config: CoreConfig, openURL: @escaping @Sendable (String) -> Bool) throws {
    let (events, continuation) = AsyncStream.makeStream(of: CoreEvent.self)
    self.events = events
    let callbacks = Unmanaged.passRetained(
      CoreCallbacks(events: continuation, openURL: openURL))
    self.callbacks = callbacks

    let configJSON = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
    var errorOut: UnsafeMutablePointer<CChar>?
    let handle = reflect_core_new(
      configJSON,
      { ctx, name, json, jsonLength in
        guard let ctx, let name else { return }
        let callbacks = Unmanaged<CoreCallbacks>.fromOpaque(ctx).takeUnretainedValue()
        let payload = Data(bytes: json, count: jsonLength)
        callbacks.events.yield(CoreEvent(name: String(cString: name), payload: payload))
      },
      { _, task in
        // The address crosses to the main queue as an integer: a raw pointer is not `Sendable`.
        let address = UInt(bitPattern: task)
        DispatchQueue.main.async {
          reflect_core_run_task(UnsafeMutableRawPointer(bitPattern: address))
        }
      },
      { ctx, url in
        guard let ctx, let url else { return false }
        let callbacks = Unmanaged<CoreCallbacks>.fromOpaque(ctx).takeUnretainedValue()
        return callbacks.openURL(String(cString: url))
      },
      callbacks.toOpaque(),
      &errorOut)
    guard let handle else {
      callbacks.release()
      let message = errorOut.map { String(cString: $0) } ?? "the core did not start"
      reflect_core_string_free(errorOut)
      throw CoreStartError(description: message)
    }
    self.handle = handle
  }

  deinit {
    // No call is in flight: each one holds a reference to the core. After
    // `reflect_core_free` returns, the core runs no callback.
    reflect_core_free(handle)
    callbacks.takeUnretainedValue().events.finish()
    callbacks.release()
  }

  /// Runs `command`. `args` is a JSON object of camelCase arguments, `headers`
  /// a JSON object of lowercase header names, and `body` the raw request body.
  /// Empty data stands for `{}` or no body.
  func dispatch(
    _ command: String, args: Data = Data(), headers: Data = Data(), body: Data = Data()
  ) async -> CoreReply {
    await withCheckedContinuation { continuation in
      let reply = Unmanaged.passRetained(PendingReply(continuation)).toOpaque()
      args.withUnsafeBytes { args in
        headers.withUnsafeBytes { headers in
          body.withUnsafeBytes { body in
            reflect_core_dispatch(
              handle,
              command,
              args.bindMemory(to: UInt8.self).baseAddress, args.count,
              headers.bindMemory(to: UInt8.self).baseAddress, headers.count,
              body.bindMemory(to: UInt8.self).baseAddress, body.count,
              PendingReply.resume, reply)
          }
        }
      }
    }
  }

  /// The JSON answer of `reflect_core_asset_resolve` for a `reflect-asset`
  /// request: its percent-decoded path, its query string and its `Range`
  /// header.
  func resolveAssetJSON(path: String, query: String?, range: String?) async -> CoreReply {
    await withCheckedContinuation { continuation in
      let reply = Unmanaged.passRetained(PendingReply(continuation)).toOpaque()
      reflect_core_asset_resolve(handle, path, query, range, PendingReply.resume, reply)
    }
  }
}

extension Data {
  /// Copies `count` bytes from a pointer that may be NULL when `count` is 0.
  fileprivate init(bytes: UnsafePointer<UInt8>?, count: Int) {
    if let bytes, count > 0 {
      self.init(bytes: UnsafeRawPointer(bytes), count: count)
    } else {
      self.init()
    }
  }
}

/// The context of the core's event, main-thread and open-URL callbacks.
private final class CoreCallbacks: Sendable {
  let events: AsyncStream<CoreEvent>.Continuation
  let openURL: @Sendable (String) -> Bool

  init(events: AsyncStream<CoreEvent>.Continuation, openURL: @escaping @Sendable (String) -> Bool) {
    self.events = events
    self.openURL = openURL
  }
}

/// One call that waits for its reply. The core calls `resume` exactly once.
private final class PendingReply {
  private let continuation: CheckedContinuation<CoreReply, Never>

  init(_ continuation: CheckedContinuation<CoreReply, Never>) {
    self.continuation = continuation
  }

  /// The reply callback of the C interface. `ctx` is a retained `PendingReply`.
  static let resume:
    @convention(c) (
      UnsafeMutableRawPointer?, Int32, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int
    ) -> Void = { ctx, status, json, jsonLength, bytes, bytesLength in
      guard let ctx else { return }
      let reply = Unmanaged<PendingReply>.fromOpaque(ctx).takeRetainedValue()
      switch status {
      case Int32(REFLECT_STATUS_JSON):
        reply.continuation.resume(returning: .json(Data(bytes: json, count: jsonLength)))
      case Int32(REFLECT_STATUS_BYTES):
        reply.continuation.resume(returning: .bytes(Data(bytes: bytes, count: bytesLength)))
      default:
        reply.continuation.resume(returning: .error(Data(bytes: json, count: jsonLength)))
      }
    }
}
