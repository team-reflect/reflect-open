import Foundation
import ReflectCoreFFI
import os

/// The directories and user agent that the Rust core starts with.
struct CoreConfig: Encodable, Sendable {
  var documentDir: String
  var dataDir: String
  var userAgent: String
}

/// The result of one command: a JSON value, raw bytes, or a `{kind, message}` error as JSON.
enum CoreReply: Sendable, Equatable {
  case json(Data)
  case bytes(Data)
  case error(Data)

  /// An error reply with the wire shape of the core's `AppError`.
  static func error(kind: String, message: String) -> CoreReply {
    let json = try? JSONSerialization.data(withJSONObject: ["kind": kind, "message": message])
    return .error(json ?? Data(#"{"kind":"unknown","message":""}"#.utf8))
  }
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
/// Rust threads; `dispatch` suspends until the reply arrives.
///
/// `close()` frees the core: every `dispatch` that still waits, and every
/// later one, gets an `io` error. Releasing the last reference closes the
/// core too.
final class ReflectCore: Sendable {
  /// The events of the core, in the order it emitted them.
  let events: AsyncStream<CoreEvent>

  // `OpaquePointer` is not `Sendable`; the C interface accepts calls from any thread.
  private nonisolated(unsafe) let handle: OpaquePointer
  private let callbacks: Unmanaged<CoreCallbacks>
  private let pending = PendingReplies()
  private let lifetime = CoreLifetime()

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
    close()
  }

  /// Frees the core. It returns after every call into the core returned and
  /// every running callback finished. Commands that run at that moment
  /// finish, but their `dispatch` calls get an `io` error, like every later
  /// call. `events` ends. Every call of `close()` returns only after the
  /// shutdown is complete. Do not call it from a callback of the core.
  func close() {
    lifetime.close {
      reflect_core_free(handle)
      pending.failAll()
      callbacks.takeUnretainedValue().events.finish()
      callbacks.release()
    }
  }

  /// Runs `command`. `args` is a JSON object of camelCase arguments, `headers`
  /// a JSON object of lowercase header names, and `body` the raw request body.
  /// Empty data stands for `{}` or no body.
  func dispatch(
    _ command: String, args: Data = Data(), headers: Data = Data(), body: Data = Data()
  ) async -> CoreReply {
    await withCheckedContinuation { continuation in
      let reply = PendingReply(continuation: continuation, owner: pending)
      let isOpen = lifetime.whileOpen {
        pending.add(reply)
        send(command, args: args, headers: headers, body: body, reply: reply)
      }
      if isOpen == nil {
        continuation.resume(returning: PendingReplies.closedReply)
      }
    }
  }

  /// Hands one command to the core. The call returns at once; the reply
  /// arrives on a Rust thread.
  private func send(
    _ command: String, args: Data, headers: Data, body: Data, reply: PendingReply
  ) {
    args.withUnsafeBytes { args in
      headers.withUnsafeBytes { headers in
        body.withUnsafeBytes { body in
          reflect_core_dispatch(
            handle,
            command,
            args.bindMemory(to: UInt8.self).baseAddress, args.count,
            headers.bindMemory(to: UInt8.self).baseAddress, headers.count,
            body.bindMemory(to: UInt8.self).baseAddress, body.count,
            { ctx, status, json, jsonLength, bytes, bytesLength in
              guard let ctx else { return }
              let reply = Unmanaged<PendingReply>.fromOpaque(ctx).takeUnretainedValue()
              switch status {
              case Int32(REFLECT_STATUS_JSON):
                reply.resume(.json(Data(bytes: json, count: jsonLength)))
              case Int32(REFLECT_STATUS_BYTES):
                reply.resume(.bytes(Data(bytes: bytes, count: bytesLength)))
              default:
                reply.resume(.error(Data(bytes: json, count: jsonLength)))
              }
            },
            Unmanaged.passUnretained(reply).toOpaque())
        }
      }
    }
  }

  /// The JSON answer of `reflect_core_asset_resolve`: `{path, mime}` or
  /// `{kind, message, status}`. It reads the first bytes of the file, so it
  /// blocks the calling thread while iCloud downloads the file. A closed core
  /// answers empty data. `close()` waits for a call that runs.
  func resolveAssetJSONBlocking(_ generation: UInt64, _ path: String, _ rasterOnly: Bool)
    -> Data
  {
    let answer = lifetime.whileOpen { () -> Data in
      guard let json = reflect_core_asset_resolve(handle, generation, path, rasterOnly) else {
        return Data()
      }
      defer { reflect_core_string_free(json) }
      return Data(bytes: json, count: strlen(json))
    }
    return answer ?? Data()
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

/// Guards the handle of the core: calls into the core run only while it is
/// open, and the core is freed only after every such call returned.
private final class CoreLifetime: @unchecked Sendable {
  private enum State {
    case open
    case closing
    case closed
  }

  private let condition = NSCondition()
  private var state = State.open
  private var callsInFlight = 0

  /// Runs `call` when the core is open and returns its value, else nil.
  func whileOpen<T>(_ call: () -> T) -> T? {
    condition.lock()
    guard state == .open else {
      condition.unlock()
      return nil
    }
    callsInFlight += 1
    condition.unlock()
    defer {
      condition.lock()
      callsInFlight -= 1
      condition.broadcast()
      condition.unlock()
    }
    return call()
  }

  /// The first call waits for the calls in flight, then runs `free`. Every
  /// call returns after `free` finished.
  func close(_ free: () -> Void) {
    condition.lock()
    guard state == .open else {
      while state != .closed {
        condition.wait()
      }
      condition.unlock()
      return
    }
    state = .closing
    while callsInFlight > 0 {
      condition.wait()
    }
    condition.unlock()

    free()

    condition.lock()
    state = .closed
    condition.broadcast()
    condition.unlock()
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

/// One `dispatch` call that waits for its reply. `PendingReplies` keeps it
/// alive until it resumes.
private final class PendingReply: Sendable {
  private let continuation: CheckedContinuation<CoreReply, Never>
  private let owner: PendingReplies

  init(continuation: CheckedContinuation<CoreReply, Never>, owner: PendingReplies) {
    self.continuation = continuation
    self.owner = owner
  }

  /// Resumes the call, once: a later call does nothing.
  func resume(_ reply: CoreReply) {
    if owner.remove(self) {
      continuation.resume(returning: reply)
    }
  }
}

/// The `dispatch` calls that did not get their reply yet.
private final class PendingReplies: Sendable {
  private let replies = OSAllocatedUnfairLock(initialState: [ObjectIdentifier: PendingReply]())

  func add(_ reply: PendingReply) {
    replies.withLock { $0[ObjectIdentifier(reply)] = reply }
  }

  /// Returns whether `reply` was still waiting.
  func remove(_ reply: PendingReply) -> Bool {
    replies.withLock { $0.removeValue(forKey: ObjectIdentifier(reply)) != nil }
  }

  /// Answers every waiting call with an `io` error. The core never sends a
  /// reply that is not out when it is freed.
  func failAll() {
    let waiting = replies.withLock { Array($0.values) }
    for reply in waiting {
      reply.resume(Self.closedReply)
    }
  }

  /// The reply of a call that the closed core does not answer.
  static var closedReply: CoreReply { .error(kind: "io", message: "the core is closed") }
}
