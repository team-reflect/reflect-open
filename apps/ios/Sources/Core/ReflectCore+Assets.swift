import Foundation
import TypesShared
import WebHostKit

extension ReflectCore {
  /// Resolves a `reflect-asset` request from its percent-decoded path, its
  /// query string and its `Range` header.
  func resolveAsset(requestPath: String, query: String?, range: String?) async -> AssetResolution {
    guard
      case .json(let json) = await resolveAssetJSON(path: requestPath, query: query, range: range),
      let reply = try? JSONDecoder().decode(AssetResolveReply.self, from: json)
    else { return .refused(status: 500) }
    switch reply {
    case .file(let file):
      return .file(
        path: file.path, mime: file.mime, total: file.total,
        range: file.range.map { $0.start...$0.end })
    case .refused(let refusal):
      return .refused(status: Int(refusal.status), total: refusal.total)
    }
  }
}
