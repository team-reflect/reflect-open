import XCTest

@testable import Reflect

final class ReflectCoreTests: XCTestCase {
  private func makeCore() throws -> ReflectCore {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ReflectCoreTests-\(UUID().uuidString)")
    let documents = root.appendingPathComponent("Documents")
    let data = root.appendingPathComponent("Data")
    for directory in [documents, data] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return try ReflectCore(
      config: CoreConfig(
        documentDir: documents.path, dataDir: data.path, userAgent: "Reflect/test"),
      openURL: { _ in false })
  }

  func testCommandRepliesJSON() async throws {
    let core = try makeCore()
    guard case .json(let json) = await core.dispatch("settings_load") else {
      return XCTFail("settings_load did not reply JSON")
    }
    XCTAssertNotNil(try JSONSerialization.jsonObject(with: json, options: .fragmentsAllowed))
  }

  func testUnknownCommandRepliesNotFound() async throws {
    let core = try makeCore()
    guard case .error(let json) = await core.dispatch("no_such_command", args: Data("{}".utf8))
    else {
      return XCTFail("no_such_command did not reply an error")
    }
    let error = try JSONSerialization.jsonObject(with: json) as? [String: String]
    XCTAssertEqual(error?["kind"], "notFound")
  }

  func testManyCallsEachGetTheirReply() async throws {
    let core = try makeCore()
    await withTaskGroup(of: Bool.self) { group in
      for _ in 0..<50 {
        group.addTask {
          if case .json = await core.dispatch("settings_load") { return true }
          return false
        }
      }
      for await ok in group {
        XCTAssertTrue(ok)
      }
    }
  }
}
