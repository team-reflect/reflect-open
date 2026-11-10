import Foundation
import Testing

@testable import ReflectCapture

// FIXME: [review by claude-opus-5-5]: every test leaves a UUID directory in the temp dir (same in `RecordingFilesTests`). Minor, but a
//   `defer { try? FileManager.default.removeItem(at:) }` or a shared helper would keep runs clean.
private func makeInbox() -> URL {
  FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
}

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
  let long = String(repeating: "x", count: 10_001)
  #expect(CaptureInbox.foldedLine(long)?.utf16.count == 10_000)
}

@Test func foldedParent() {
  #expect(CaptureInbox.foldedParent("  Ideas \n inbox ") == "Ideas inbox")
  #expect(CaptureInbox.foldedParent("   ") == nil)
  let long = String(repeating: "x", count: 201)
  #expect(CaptureInbox.foldedParent(long)?.utf16.count == 200)
}

@Test func cappedTitleKeepsWholeCharacters() throws {
  let inbox = makeInbox()
  // Each 👍🏽 is 4 UTF-16 units, so 1 000 units cannot end on a whole one
  // after a 1-unit prefix.
  let title = "a" + String(repeating: "👍🏽", count: 400)
  try CaptureInbox.spoolLink(
    url: "https://example.com", title: title, selection: nil, metaDescription: nil, into: inbox)

  let capped = try #require(try readOnlyEnvelope(in: inbox)["title"] as? String)
  #expect(capped.utf16.count <= 1_000)
  #expect(capped.utf16.count > 990)
  #expect(capped.dropFirst().allSatisfy { $0 == "👍🏽" })
}

@Test func oversizedEnvelopeDropsSelectionFirst() throws {
  let inbox = makeInbox()
  // About 58 KB of URL plus a 10 000-unit selection exceeds 64 KB; without the
  // selection it fits again, so only the selection is shed.
  let longUrl = "https://e.com/" + String(repeating: "a", count: 58_000)
  let selection = String(repeating: "s", count: 10_000)
  try CaptureInbox.spoolLink(
    url: longUrl, title: "t", selection: selection, metaDescription: "desc", into: inbox)

  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["selection"] == nil)
  #expect(json["metaDescription"] as? String == "desc")
}

@Test func dropsDescriptionWhenSelectionIsNotEnough() throws {
  let inbox = makeInbox()
  // Without the selection the envelope is still over 64 KB; without the
  // description too it fits.
  let longUrl = "https://e.com/" + String(repeating: "a", count: 64_000)
  try CaptureInbox.spoolLink(
    url: longUrl, title: "t", selection: String(repeating: "s", count: 10_000),
    metaDescription: String(repeating: "d", count: 2_000), into: inbox)

  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["selection"] == nil)
  #expect(json["metaDescription"] == nil)
  #expect(json["url"] as? String == longUrl)
}

@Test func urlBeyondCapThrows() {
  let inbox = makeInbox()
  let hugeUrl = "https://e.com/" + String(repeating: "a", count: 70_000)
  #expect(throws: CaptureInboxError.self) {
    try CaptureInbox.spoolLink(
      url: hugeUrl, title: "t", selection: nil, metaDescription: nil, into: inbox)
  }
  #expect(!FileManager.default.fileExists(atPath: inbox.path))
}

// FIXME: [review by claude-opus-5-5]: the name promises atomicity, but the test only checks that no `.json.tmp` is left behind
//   after a successful write. Rename it (e.g. `writesOneCommittedEnvelope`) or drop the claim.
@Test func writesAtomically() throws {
  let inbox = makeInbox()
  try CaptureInbox.spoolLink(
    url: "https://example.com", title: "Example", selection: " picked ", metaDescription: "",
    into: inbox)

  let files = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
  #expect(files.count == 1)
  #expect(files.allSatisfy { $0.hasSuffix(".json") && !$0.hasSuffix(".json.tmp") })
  let json = try readOnlyEnvelope(in: inbox)
  #expect(json["version"] as? Int == 1)
  #expect(json["source"] as? String == "ios-share")
  #expect(json["selection"] as? String == "picked")
  #expect(json["metaDescription"] == nil)
  let id = try #require(json["id"] as? String)
  #expect(files == ["\(id).json"])
  #expect(id == id.lowercased())
}

@Test func spoolTextSkipsBlank() throws {
  let inbox = makeInbox()
  #expect(
    try CaptureInbox.spoolText(" \n ", source: "ios-share", parent: nil, into: inbox) == false)
  #expect(!FileManager.default.fileExists(atPath: inbox.path))
  // The public entry point returns false before it looks up the App Group
  // container, which the test process does not have.
  #expect(try CaptureInbox.spoolText(" \n ", source: "ios-share", parent: nil) == false)
}

// FIXME: [review by claude-opus-5-5]: `capture-envelope.test.ts` pins a literal Swift JSON fixture to the zod schema, but nothing pins
//   the Swift encoder to that fixture: the two can drift. Idea: let `spoolLink` / `spoolText` take
//   `id` and `now` (internal params), then assert the encoded JSON equals the exact strings used in
//   the TS test (with `.sortedKeys`). Then both sides check one shared shape.
@Test func spoolTextEnvelopeShape() throws {
  let inbox = makeInbox()
  #expect(
    try CaptureInbox.spoolText(
      "first\nsecond", source: "ios-intent", parent: "  Daily \n log ", into: inbox))

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
