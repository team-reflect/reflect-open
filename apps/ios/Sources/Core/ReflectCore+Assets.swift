import Foundation
import ReflectCoreFFI

extension ReflectCore {
  private static let assetQueue = DispatchQueue(
    label: "app.reflect.asset-resolve", qos: .userInitiated, attributes: .concurrent)

  /// The JSON answer of `reflect_core_asset_resolve`. The call reads the file
  /// and can block while iCloud downloads it, so it runs on a dispatch queue,
  /// not on a thread of the Swift concurrency pool.
  private func resolveAssetJSON(_ generation: UInt64, _ path: String, _ rasterOnly: Bool) async
    -> Data
  {
    await withCheckedContinuation { continuation in
      Self.assetQueue.async {
        continuation.resume(returning: self.resolveAssetJSONBlocking(generation, path, rasterOnly))
      }
    }
  }

  /// Resolves the percent-decoded path of a `reflect-asset` request:
  /// `<generation>/<graph-relative path>`, or `<generation>/x-media/<post>/<hash>`
  /// for archived X media, which waits for its download.
  @concurrent
  func resolveAsset(requestPath: String, rasterOnly: Bool) async -> AssetResolution {
    let segments = requestPath.split(separator: "/", omittingEmptySubsequences: false)
    if segments.count > 1, segments[1] == "x-media" {
      guard let args = try? JSONSerialization.data(withJSONObject: ["path": requestPath]),
        case .json(let json) = await dispatch("x_media_resolve", args: args)
      else { return .refused(status: 500) }
      return Self.resolution(from: json)
    }
    guard let slash = requestPath.firstIndex(of: "/"),
      let generation = UInt64(requestPath[..<slash])
    else { return .refused(status: 400) }
    let path = String(requestPath[requestPath.index(after: slash)...])
    return Self.resolution(from: await resolveAssetJSON(generation, path, rasterOnly))
  }

  /// Reads `{path, mime}` or `{status}` from a resolver's JSON answer.
  private static func resolution(from json: Data) -> AssetResolution {
    struct Answer: Decodable {
      var path: String?
      var mime: String?
      var bytes: UInt64?
      var status: Int?
    }
    guard let answer = try? JSONDecoder().decode(Answer.self, from: json) else {
      return .refused(status: 500)
    }
    if let path = answer.path, let mime = answer.mime {
      return .file(path: path, mime: mime, length: answer.bytes)
    }
    return .refused(status: answer.status ?? 500)
  }
}
