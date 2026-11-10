import Foundation
import Testing

@testable import CaptureShared

private func makeInbox() -> URL {
  FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
}

private let testId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
/// 2026-07-05T07:12:30.123Z
private let testNow = Date(timeIntervalSince1970: 1_783_235_550.123)

private func readOnlyEnvelope(in inbox: URL) throws -> [String: Any] {
  let files = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
  #expect(files.count == 1)
  let file = try #require(files.first)
  #expect(file.hasSuffix(".json"))
  let data = try Data(contentsOf: inbox.appendingPathComponent(file))
  return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Test(arguments: [
  ("https://example.com", true),
  ("http://example.com", true),
  ("ftp://example.com", false),
  ("example.com", false),
])
func isHttpUrl(candidate: String, expected: Bool) {
  #expect(CaptureInbox.isHttpUrl(candidate) == expected)
}

@Test func foldedLine() {
  #expect(CaptureInbox.foldedLine("  a \n\t b  ") == "a b")
  #expect(CaptureInbox.foldedLine(" \n\t ") == nil)
  let long = String((0..<10_001).map { Character(String($0 % 10)) })
  #expect(CaptureInbox.foldedLine(long) == String(long.prefix(10_000)))
}

@Test func foldedParent() {
  #expect(CaptureInbox.foldedParent("  Ideas \n inbox ") == "Ideas inbox")
  #expect(CaptureInbox.foldedParent("   ") == nil)
  let long = String((0..<201).map { Character(String($0 % 10)) })
  #expect(CaptureInbox.foldedParent(long) == String(long.prefix(200)))
}

@Test func cappedTitleKeepsWholeCharacters() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  // Each 👍🏽 is 4 UTF-16 units, so 1 000 units cannot end on a whole one
  // after a 1-unit prefix.
  let title = "a" + String(repeating: "👍🏽", count: 400)
  try CaptureInbox.spoolLink(
    url: "https://example.com", title: title, selection: nil, metaDescription: nil, id: testId,
    now: testNow, into: inbox)

  let capped = try #require(try readOnlyEnvelope(in: inbox)["title"] as? String)
  #expect(capped.utf16.count <= 1_000)
  #expect(capped.utf16.count > 990)
  // A whole-character prefix: a cut inside 👍🏽 would not match.
  #expect(title.hasPrefix(capped))
}

@Test func oversizedEnvelopeDropsSelectionFirst() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  // About 58 KB of URL plus a 10 000-unit selection exceeds 64 KB; without the
  // selection it fits again, so only the selection is shed.
  let longUrl = "https://e.com/" + String(repeating: "a", count: 58_000)
  let selection = String(repeating: "s", count: 10_000)
  try CaptureInbox.spoolLink(
    url: longUrl, title: "t", selection: selection, metaDescription: "desc", id: testId,
    now: testNow, into: inbox)

  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["selection"] == nil)
  #expect(json["metaDescription"] as? String == "desc")
}

@Test func dropsDescriptionWhenSelectionIsNotEnough() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  // Without the selection the envelope is still over 64 KB; without the
  // description too it fits.
  let longUrl = "https://e.com/" + String(repeating: "a", count: 64_000)
  try CaptureInbox.spoolLink(
    url: longUrl, title: "t", selection: String(repeating: "s", count: 10_000),
    metaDescription: String(repeating: "d", count: 2_000), id: testId, now: testNow, into: inbox)

  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["selection"] == nil)
  #expect(json["metaDescription"] == nil)
  #expect(json["url"] as? String == longUrl)
}

@Test func urlBeyondCapThrows() {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  let hugeUrl = "https://e.com/" + String(repeating: "a", count: 70_000)
  #expect(throws: CaptureInboxError.self) {
    try CaptureInbox.spoolLink(
      url: hugeUrl, title: "t", selection: nil, metaDescription: nil, id: testId, now: testNow,
      into: inbox)
  }
  #expect(!FileManager.default.fileExists(atPath: inbox.path))
}

@Test func writesOneCommittedEnvelope() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  try CaptureInbox.spoolLink(
    url: "https://example.com", title: "Example", selection: " picked ", metaDescription: "",
    id: testId, now: testNow, into: inbox)

  let files = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
  #expect(files.count == 1)
  #expect(files.allSatisfy { $0.hasSuffix(".json") && !$0.hasSuffix(".json.tmp") })
  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["version"] as? Int == 1)
  #expect(json["source"] as? String == "ios-share")
  #expect(json["selection"] as? String == "picked")
  #expect(json["metaDescription"] == nil)
  #expect(files == ["\(testId).json"])
}

@Test func envelopeIdIsLowercaseUUID() {
  let id = CaptureInbox.envelopeId()
  #expect(id == id.lowercased())
  #expect(UUID(uuidString: id) != nil)
}

@Test func spoolTextSkipsBlank() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  #expect(
    try CaptureInbox.spoolText(
      " \n ", source: "ios-share", parent: nil, id: testId, now: testNow, into: inbox) == false)
  #expect(!FileManager.default.fileExists(atPath: inbox.path))
  // The public entry point returns false before it looks up the App Group
  // container, which the test process does not have.
  #expect(try CaptureInbox.spoolText(" \n ", source: "ios-share", parent: nil) == false)
}

@Test func spoolTextEnvelopeShape() throws {
  let inbox = makeInbox()
  defer { try? FileManager.default.removeItem(at: inbox) }
  #expect(
    try CaptureInbox.spoolText(
      "first\nsecond", source: "ios-intent", parent: "  Daily \n log ", id: testId, now: testNow,
      into: inbox))

  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["version"] as? Int == 1)
  #expect(json["kind"] as? String == "append")
  #expect(json["text"] as? String == "first second")
  #expect(json["source"] as? String == "ios-intent")
  #expect(json["parent"] as? String == "Daily log")
  let capturedAt = try #require(json["capturedAt"] as? String)
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  #expect(formatter.date(from: capturedAt) != nil)
}

/// The same strings `capture-envelope.test.ts` parses with the zod schema, so
/// both sides check one envelope shape. Update both together.
@Test func swiftProducerShapes() throws {
  let link = makeInbox()
  defer { try? FileManager.default.removeItem(at: link) }
  try CaptureInbox.spoolLink(
    url: "https://example.com/article", title: "An article", selection: "quoted text",
    metaDescription: "A page about examples.", id: testId, now: testNow, into: link)
  let expectedLink = try JSONSerialization.jsonObject(
    with: Data(
      ("{\"capturedAt\":\"2026-07-05T07:12:30.123Z\",\"id\":\"7c9e6679-7425-40de-944b-e07fc1f90ae7\","
        + "\"metaDescription\":\"A page about examples.\",\"selection\":\"quoted text\","
        + "\"source\":\"ios-share\",\"title\":\"An article\",\"url\":\"https://example.com/article\",\"version\":1}")
        .utf8))
  #expect(try readOnlyEnvelope(in: link) as NSDictionary == expectedLink as? NSDictionary)

  let text = makeInbox()
  defer { try? FileManager.default.removeItem(at: text) }
  #expect(
    try CaptureInbox.spoolText(
      "call the bank", source: "ios-share", parent: nil, id: testId, now: testNow, into: text))
  let expectedText = try JSONSerialization.jsonObject(
    with: Data(
      ("{\"capturedAt\":\"2026-07-05T07:12:30.123Z\",\"id\":\"7c9e6679-7425-40de-944b-e07fc1f90ae7\","
        + "\"kind\":\"append\",\"source\":\"ios-share\",\"text\":\"call the bank\",\"version\":1}")
        .utf8))
  #expect(try readOnlyEnvelope(in: text) as NSDictionary == expectedText as? NSDictionary)
}
