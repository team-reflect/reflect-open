import Foundation
import WebHostKit

extension ReflectCore {
  /// Resolves a `reflect-asset` request from its percent-decoded path, its
  /// query string and its `Range` header.
  func resolveAsset(requestPath: String, query: String?, range: String?) async -> AssetResolution {
    struct Answer: Decodable {
      var path: String?
      var mime: String?
      var total: UInt64?
      var range: [UInt64]?
      var status: Int?
    }
    guard
      case .json(let json) = await resolveAssetJSON(path: requestPath, query: query, range: range),
      let answer = try? JSONDecoder().decode(Answer.self, from: json)
    else { return .refused(status: 500) }
    guard let path = answer.path, let mime = answer.mime, let total = answer.total else {
      return .refused(status: answer.status ?? 500, total: answer.total)
    }
    let range = answer.range.flatMap { $0.count == 2 ? $0[0]...$0[1] : nil }
    return .file(path: path, mime: mime, total: total, range: range)
  }
}
