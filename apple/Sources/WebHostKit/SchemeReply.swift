public import Foundation

/// An HTTP response for a `reflect-app` request.
public struct SchemeReply: Sendable {
  public var statusCode: Int
  public var headers: [String: String]
  public var body: Data

  public init(statusCode: Int, headers: [String: String], body: Data) {
    self.statusCode = statusCode
    self.headers = headers
    self.body = body
  }
}
