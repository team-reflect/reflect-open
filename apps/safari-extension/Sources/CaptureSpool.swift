import Foundation
import TypesShared

/// Spools one wire message from the web extension into the App Group inbox
/// the desktop app relays into the graph (`relay_shared_spools` in
/// `capture.rs`). It is the spool step of `reflect-capture-host`
/// (`apps/native-host`) without the host's envelope validation: the extension
/// parses every wire message with zod before sending it, and the drain parses
/// every spool file again and quarantines what fails. The checks kept here
/// guard the disk: the id names the spool files, and the sizes stay inside
/// what the relay will copy. The envelope stays a dictionary because the
/// extension also relays X post envelopes through it.
enum CaptureSpool {
  /// The ack for one wire message: `{ok: true, status: "queued"}`, or a
  /// typed failure the extension maps to a hold or a drop.
  static func spool(_ message: Any?) -> [String: Any] {
    spool(message, into: inboxUrl)
  }

  /// `spool(_:)` with the inbox resolved by `inbox`, so the spool step can
  /// run outside the app extension's container.
  static func spool(_ message: Any?, into inbox: () throws -> URL) -> [String: Any] {
    let ack: CaptureAck
    do {
      try write(message, into: inbox)
      ack = CaptureAck(ok: true, status: "queued", code: nil, message: nil)
    } catch let failure as SpoolFailure {
      ack = CaptureAck(ok: false, status: nil, code: failure.code, message: failure.message)
    } catch {
      ack = CaptureAck(ok: false, status: nil, code: .io, message: error.localizedDescription)
    }
    // Safari takes the reply as Foundation objects.
    guard let data = try? JSONEncoder().encode(ack),
      let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return ["ok": false, "code": CaptureErrorCode.io.rawValue]
    }
    return reply
  }

  /// Mirrors `ValidatedCapture::parse` and `spool_capture` in the native
  /// host: decode the screenshot into `<id>.jpg`, stamp `screenshotRef`,
  /// then commit `<id>.json` last, since the envelope is what the relay
  /// and the drain key on.
  private static func write(_ message: Any?, into inboxUrl: () throws -> URL) throws {
    guard
      let wire = message as? [String: Any],
      var envelope = wire["envelope"] as? [String: Any]
    else {
      throw SpoolFailure.invalidPayload("Invalid capture message")
    }
    // The id names the spool files, so a strict UUID shape doubles as
    // the path-safety guard: no separators, no dots.
    guard let id = envelope["id"] as? String, UUID(uuidString: id) != nil else {
      throw SpoolFailure.invalidPayload("id is not a UUID")
    }
    var screenshot: Data?
    if let encoded = wire["screenshotBase64"], !(encoded is NSNull) {
      guard let encoded = encoded as? String, let bytes = Data(base64Encoded: encoded),
        !bytes.isEmpty
      else {
        throw SpoolFailure.invalidPayload("screenshot is not base64")
      }
      guard bytes.count <= CaptureConstants.sharedScreenshotMaxBytes else {
        throw SpoolFailure.invalidPayload("screenshot is too large to save")
      }
      screenshot = bytes
      envelope["screenshotRef"] = "\(id).jpg"
    }
    // Safari hands the message over as Foundation objects; anything that
    // is not JSON would raise an Objective-C exception below.
    guard JSONSerialization.isValidJSONObject(envelope) else {
      throw SpoolFailure.invalidPayload("Invalid capture message")
    }
    let json = try JSONSerialization.data(
      withJSONObject: envelope, options: [.withoutEscapingSlashes])
    guard json.count <= CaptureConstants.sharedEnvelopeMaxBytes else {
      throw SpoolFailure.invalidPayload("capture is too large to save")
    }
    let inbox = try inboxUrl()
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    if let screenshot {
      try commit(screenshot, as: "\(id).jpg", in: inbox)
    }
    try commit(json, as: "\(id).json", in: inbox)
  }

  /// Write a `.tmp` sibling, then rename it over the committed name. The
  /// relay copies only committed names and sweeps old `.tmp` debris, so it
  /// never sees a partial file; a retried capture replaces its own files.
  private static func commit(_ data: Data, as name: String, in inbox: URL) throws {
    let tmp = inbox.appendingPathComponent("\(name).tmp")
    try data.write(to: tmp)
    guard rename(tmp.path, inbox.appendingPathComponent(name).path) == 0 else {
      throw SpoolFailure.io(String(cString: strerror(errno)))
    }
  }

  private static func inboxUrl() throws -> URL {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: CaptureConstants.appGroupKey) as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else {
      // An entitlements or build-settings mismatch, not a user-fixable state.
      throw SpoolFailure.io("The Reflect capture inbox is unavailable")
    }
    return container.appendingPathComponent(CaptureConstants.sharedInboxDir, isDirectory: true)
  }
}

/// The failure half of `CaptureAck`.
private enum SpoolFailure: Error {
  /// The extension drops the capture: retrying cannot help.
  case invalidPayload(String)
  /// The extension keeps the capture queued and retries.
  case io(String)

  var code: CaptureErrorCode {
    switch self {
    case .invalidPayload: .invalidPayload
    case .io: .io
    }
  }

  var message: String {
    switch self {
    case .invalidPayload(let message), .io(let message): message
    }
  }
}
