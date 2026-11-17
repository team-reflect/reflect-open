import Foundation
import Testing

@testable import WebHostKit

private func urls(_ strings: String...) -> [URL] {
  strings.compactMap(URL.init(string:))
}

private func payloadStrings(_ opened: OpenedURLs) throws -> [String]? {
  guard let payload = opened.linksPayload else { return nil }
  return try #require(JSONSerialization.jsonObject(with: payload) as? [String])
}

@Test func aLinkGoesToThePage() throws {
  let opened = OpenedURLs(urls("reflect://tasks", "reflect://note/abc?x=1"))
  #expect(!opened.requestsRecording)
  #expect(try payloadStrings(opened) == ["reflect://tasks", "reflect://note/abc?x=1"])
}

@Test func theRecordAudioURLRequestsARecordingAndDoesNotGoToThePage() throws {
  let opened = OpenedURLs(urls("reflect://record-audio"))
  #expect(opened.requestsRecording)
  #expect(opened.links.isEmpty)
  #expect(opened.linksPayload == nil)
}

@Test func aRecordingRequestAndALinkAreBothHandled() throws {
  let opened = OpenedURLs(urls("reflect://record-audio", "reflect://today"))
  #expect(opened.requestsRecording)
  #expect(try payloadStrings(opened) == ["reflect://today"])
}

@Test(arguments: [
  "https://record-audio", "reflect://record-audio-2", "reflect://tasks/record-audio",
])
func onlyTheReflectRecordAudioHostRequestsARecording(url: String) throws {
  let opened = OpenedURLs(urls(url))
  #expect(!opened.requestsRecording)
  #expect(try payloadStrings(opened) == [url])
}

@Test func noURLsDoNothing() {
  let opened = OpenedURLs([])
  #expect(!opened.requestsRecording)
  #expect(opened.linksPayload == nil)
}
