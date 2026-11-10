import Foundation
import Testing

@testable import RecordingKit

private func makeDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

private func touch(_ name: String, in directory: URL) throws -> URL {
  let url = directory.appendingPathComponent(name)
  #expect(FileManager.default.createFile(atPath: url.path, contents: Data()))
  return url
}

@Test(arguments: [
  (1_700_000_000_123.0, 1, false),
  (1_700_000_000_123.0, 7, true),
  (1_700_000_000_123.0, 1_000, false),
])
func stagedNameRoundTrip(sessionStartedMs: Double, part: Int, end: Bool) throws {
  let name = RecordingFiles.stagedName(sessionStartedMs: sessionStartedMs, part: part, end: end)
  let info = try #require(RecordingFiles.stagedInfo(path: "/staging/\(name)", modifiedMs: 5))
  #expect(info.sessionStartedMs == sessionStartedMs)
  #expect(info.part == part)
  #expect(info.end == end)
  #expect(info.modifiedMs == 5)
}

@Test func stagedNamePadsThePart() {
  #expect(
    RecordingFiles.stagedName(sessionStartedMs: 42, part: 3, end: true)
      == "recording-42.part-003-end.m4a")
}

@Test func stagedInfoParsesLegacyName() throws {
  let info = try #require(
    RecordingFiles.stagedInfo(path: "/staging/recording-1700.m4a", modifiedMs: 99))
  #expect(info.part == 1)
  #expect(info.end)
  #expect(info.sessionStartedMs == 99)
}

@Test(arguments: [
  "foo.m4a",
  "recording-abc.part-1.m4a",
  ".DS_Store",
  "recording-1.part-0.m4a",
  "recording-1.part-1.wav",
  "recording-1.segment-1.m4a",
])
func stagedInfoRejectsForeignNames(name: String) {
  #expect(RecordingFiles.stagedInfo(path: "/staging/\(name)", modifiedMs: 0) == nil)
}

@Test func markEndedRenamesToEndName() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let open = try touch("recording-42.part-002.m4a", in: directory)

  let ended = try RecordingFiles.markEnded(path: open.path, sessionStartedMs: 42, part: 2)

  #expect(URL(fileURLWithPath: ended).lastPathComponent == "recording-42.part-002-end.m4a")
  #expect(FileManager.default.fileExists(atPath: ended))
  #expect(!FileManager.default.fileExists(atPath: open.path))
  #expect(throws: (any Error).self) {
    try RecordingFiles.markEnded(path: open.path, sessionStartedMs: 42, part: 2)
  }
}

@Test func listStagedSortsNumerically() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  _ = try touch("recording-20.part-001.m4a", in: directory)
  _ = try touch("recording-10.part-1000.m4a", in: directory)
  _ = try touch("recording-10.part-999.m4a", in: directory)
  _ = try touch("notes.txt", in: directory)

  let files = try RecordingFiles.listStaged(in: directory, excluding: nil)

  #expect(files.map(\.sessionStartedMs) == [10, 10, 20])
  #expect(files.map(\.part) == [999, 1_000, 1])
}

@Test func listStagedExcludesLiveFile() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let done = try touch("recording-10.part-001.m4a", in: directory)
  let live = try touch("recording-10.part-002.m4a", in: directory)

  let files = try RecordingFiles.listStaged(
    in: directory, excluding: live.standardizedFileURL.path)

  #expect(files.map(\.path) == [done.standardizedFileURL.path])
}

@Test func sessionFilesOnlyMatchSession() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  _ = try touch("recording-10.part-001.m4a", in: directory)
  _ = try touch("recording-10.part-002-end.m4a", in: directory)
  _ = try touch("recording-100.part-001.m4a", in: directory)
  _ = try touch("recording-20.part-001.m4a", in: directory)

  let names = try RecordingFiles.sessionFiles(in: directory, sessionStartedMs: 10)
    .map(\.lastPathComponent).sorted()

  #expect(names == ["recording-10.part-001.m4a", "recording-10.part-002-end.m4a"])
}

@Test func stagedURLAcceptsFilesInside() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let path = directory.appendingPathComponent("recording-1.part-001.m4a").path
  let url = try RecordingFiles.stagedURL(for: path, in: directory)
  #expect(url == URL(fileURLWithPath: path).standardizedFileURL)
}

@Test func stagedURLRejectsEscapes() throws {
  let directory = try makeDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  for path in [
    directory.appendingPathComponent("../x.m4a").path,
    "/etc/hosts",
    directory.path,
    directory.path + "-other/x.m4a",
  ] {
    #expect(throws: (any Error).self) {
      try RecordingFiles.stagedURL(for: path, in: directory)
    }
  }
}
