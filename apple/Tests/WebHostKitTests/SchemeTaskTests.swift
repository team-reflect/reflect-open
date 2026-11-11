import XCTest

@testable import WebHostKit

@MainActor
final class SchemeTaskTests: XCTestCase {
  func testReplySendsResponseBodyAndFinish() {
    let fake = FakeSchemeTask(path: "/x")
    let task = SchemeTask(fake)
    task.reply(SchemeReply(statusCode: 201, headers: ["X-A": "1"], body: Data("hi".utf8)))

    XCTAssertEqual(fake.response?.statusCode, 201)
    XCTAssertEqual(fake.header("X-A"), "1")
    XCTAssertEqual(fake.body, Data("hi".utf8))
    XCTAssertTrue(fake.isFinished)
    XCTAssertFalse(task.isLive)
  }

  func testNothingReachesAStoppedTask() {
    let fake = FakeSchemeTask(path: "/x")
    let task = SchemeTask(fake)
    var stops = 0
    var ends = 0
    task.onStop { stops += 1 }
    task.onEnd { ends += 1 }

    task.stop()
    task.stop()
    task.respond(status: 200, headers: [:])
    task.send(Data("late".utf8))
    task.finish()
    task.fail(URLError(.cancelled))

    XCTAssertTrue(fake.isUntouched)
    XCTAssertEqual(stops, 1)
    XCTAssertEqual(ends, 1)
  }

  func testNothingReachesAnEndedTask() {
    let fake = FakeSchemeTask(path: "/x")
    let task = SchemeTask(fake)
    var stops = 0
    task.onStop { stops += 1 }

    task.respond(status: 200, headers: [:])
    task.finish()
    task.send(Data("late".utf8))
    task.fail(URLError(.cancelled))
    task.stop()

    XCTAssertTrue(fake.body.isEmpty)
    XCTAssertNil(fake.error)
    XCTAssertEqual(stops, 0)
  }

  func testBodyReadsTheStream() {
    var request = URLRequest(url: URL(fileURLWithPath: "/x"))
    let bytes = Data((0..<200_000).map { UInt8($0 % 251) })
    request.httpBodyStream = InputStream(data: bytes)
    XCTAssertEqual(SchemeTask(FakeSchemeTask(request)).body, bytes)
  }
}
