import Foundation
import Testing
import TypesShared

/// The samples Rust writes to `fixtures/wire`: each must decode with the
/// generated type and encode back to the same JSON.
private let fixtures = URL(filePath: #filePath)
  .deletingLastPathComponent()
  .appending(path: "../../../fixtures/wire")
  .standardizedFileURL

private func expectRoundTrip<T: Codable>(_ type: T.Type, _ name: String) throws {
  let data = try Data(contentsOf: fixtures.appending(path: "\(name).json"))
  let samples = try JSONDecoder().decode([T].self, from: data)
  let encoded = try JSONEncoder().encode(samples)
  let expected = try JSONSerialization.jsonObject(with: data) as? NSArray
  let actual = try JSONSerialization.jsonObject(with: encoded) as? NSArray
  #expect(actual == expected, "\(name) does not encode back to its fixture")
}

@Test func appErrorRoundTrips() throws { try expectRoundTrip(AppError.self, "AppError") }

@Test func changeKindRoundTrips() throws { try expectRoundTrip(ChangeKind.self, "ChangeKind") }

@Test func fileChangeRoundTrips() throws { try expectRoundTrip(FileChange.self, "FileChange") }

@Test func fileMetaRoundTrips() throws { try expectRoundTrip(FileMeta.self, "FileMeta") }
