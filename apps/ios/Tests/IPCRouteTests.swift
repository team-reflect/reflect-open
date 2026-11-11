import XCTest

@testable import Reflect

@MainActor
final class IPCRouteTests: XCTestCase {
  /// What the route passed to the core.
  private struct Call: Equatable {
    var command: String
    var args: String
    var headers: [String: String]
    var body: Data
  }

  @MainActor
  private final class CallLog {
    var calls: [Call] = []
  }

  private let log = CallLog()
  private var calls: [Call] { log.calls }

  private func route(
    reply: CoreReply = .json(Data("1".utf8)),
    shellCommands: [String: ShellCommand] = [:],
    allowedOrigin: String? = nil,
    gate: Gate? = nil
  ) -> IPCRoute {
    IPCRoute(
      dispatch: { [log] command, args, headers, body in
        await gate?.wait()
        let headers = (try? JSONDecoder().decode([String: String].self, from: headers)) ?? [:]
        let call = Call(
          command: command, args: String(decoding: args, as: UTF8.self), headers: headers,
          body: body)
        await MainActor.run { log.calls.append(call) }
        return reply
      },
      shellCommands: shellCommands,
      allowedOrigin: allowedOrigin)
  }

  private func post(
    _ route: IPCRoute, command: String, body: String = "{}",
    headers: [String: String] = ["Content-Type": "application/json"]
  ) async -> FakeSchemeTask {
    let fake = FakeSchemeTask(
      path: "/__ipc/\(command)", method: "POST", headers: headers, body: Data(body.utf8))
    route.start(SchemeTask(fake))
    await fake.waitForEnd()
    return fake
  }

  func testJSONCommandGoesToTheCore() async {
    let fake = await post(
      route(reply: .json(Data(#"{"a":1}"#.utf8))), command: "graph_open", body: #"{"path":"/g"}"#)

    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.command, "graph_open")
    XCTAssertEqual(calls.first?.args, #"{"path":"/g"}"#)
    XCTAssertEqual(calls.first?.body, Data())
    XCTAssertEqual(fake.response?.statusCode, 200)
    XCTAssertEqual(fake.header("Content-Type"), "application/json")
    XCTAssertNil(fake.header("x-reflect-response"))
    XCTAssertEqual(fake.body, Data(#"{"a":1}"#.utf8))
  }

  func testCommandIsPercentDecoded() async {
    var seen: [String] = []
    let commands: [String: ShellCommand] = [
      "plugin:iap|purchase": { _ in
        seen.append("purchase")
        return .json(Data("null".utf8))
      }
    ]
    _ = await post(route(shellCommands: commands), command: "plugin%3Aiap%7Cpurchase")
    XCTAssertEqual(seen, ["purchase"])
    XCTAssertEqual(calls, [])
  }

  func testBinaryCommandPassesBodyAndLowercaseHeaders() async {
    let fake = await post(
      route(reply: .bytes(Data([1, 2, 3]))), command: "asset_upload_append", body: "raw",
      headers: ["Content-Type": "application/octet-stream", "X-Upload-Id": "u1"])

    XCTAssertEqual(calls.first?.args, "")
    XCTAssertEqual(calls.first?.body, Data("raw".utf8))
    XCTAssertEqual(calls.first?.headers["x-upload-id"], "u1")
    XCTAssertEqual(fake.header("Content-Type"), "application/octet-stream")
    XCTAssertEqual(fake.body, Data([1, 2, 3]))
  }

  func testErrorReplyIsFlaggedWithStatus200() async {
    let error = CoreReply.error(kind: "notFound", message: "missing")
    let fake = await post(route(reply: error), command: "note_read")

    XCTAssertEqual(fake.response?.statusCode, 200)
    XCTAssertEqual(fake.header("x-reflect-response"), "error")
    let json = try? JSONSerialization.jsonObject(with: fake.body) as? [String: String]
    XCTAssertEqual(json, ["kind": "notFound", "message": "missing"])
  }

  func testUnknownShellCommandsDoNotReachTheCore() async {
    let route = route()
    for command in ["host.no_such", "plugin%3Aiap%7Cno_such"] {
      let fake = await post(route, command: command)
      XCTAssertEqual(fake.header("x-reflect-response"), "error")
      let json = try? JSONSerialization.jsonObject(with: fake.body) as? [String: String]
      XCTAssertEqual(json?["kind"], "notFound")
    }
    XCTAssertEqual(calls, [])
  }

  func testReplyAfterStopIsDropped() async {
    let gate = Gate()
    let fake = FakeSchemeTask(
      path: "/__ipc/slow", method: "POST", headers: ["Content-Type": "application/json"],
      body: Data("{}".utf8))
    let task = SchemeTask(fake)
    route(gate: gate).start(task)

    task.stop()
    gate.open()
    while calls.isEmpty {
      await Task.yield()
    }
    for _ in 0..<10 {
      await Task.yield()
    }

    XCTAssertTrue(fake.isUntouched)
  }

  func testDevOriginGetsCORSHeadersAndPreflight() async {
    let route = route(allowedOrigin: "http://localhost:1420")
    let preflight = FakeSchemeTask(path: "/__ipc/graph_open", method: "OPTIONS")
    route.start(SchemeTask(preflight))
    XCTAssertEqual(preflight.response?.statusCode, 204)
    XCTAssertEqual(preflight.header("Access-Control-Allow-Origin"), "http://localhost:1420")
    XCTAssertEqual(calls, [])

    let fake = await post(route, command: "graph_open")
    XCTAssertEqual(fake.header("Access-Control-Allow-Origin"), "http://localhost:1420")
    XCTAssertEqual(fake.header("Access-Control-Expose-Headers"), "x-reflect-response")
  }

  func testOtherMethodsAreRejected() async {
    let fake = FakeSchemeTask(path: "/__ipc/graph_open", method: "GET")
    route().start(SchemeTask(fake))
    XCTAssertEqual(fake.response?.statusCode, 400)
    XCTAssertEqual(calls, [])
  }

  func testEveryRequestRunsOnRequest() async {
    var requests = 0
    let route = IPCRoute(
      dispatch: { _, _, _, _ in .json(Data("1".utf8)) }, shellCommands: [:],
      onRequest: { requests += 1 })
    _ = await post(route, command: "a")
    _ = await post(route, command: "b")
    XCTAssertEqual(requests, 2)
  }
}
