public import Foundation

/// The URLs with which the system opened the app, split by what the shell
/// does with them.
public struct OpenedURLs: Sendable, Equatable {
  /// Whether a URL asks for a recording: `reflect://record-audio`.
  public var requestsRecording: Bool
  /// The other URLs, in their order. The page gets them.
  public var links: [URL]

  public init(_ urls: [URL]) {
    links = urls.filter { !($0.scheme == "reflect" && $0.host == "record-audio") }
    requestsRecording = links.count < urls.count
  }

  /// The payload of the `host:open-url` event: `links` as a JSON `string[]`.
  /// Nil when there is no link.
  public var linksPayload: Data? {
    guard !links.isEmpty else { return nil }
    return try? JSONSerialization.data(withJSONObject: links.map(\.absoluteString))
  }
}
