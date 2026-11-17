import TypesShared
import XCTest

@testable import WebHostKit

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
    shellCommands: [ShellCommandName: ShellCommand] = [:],
    devOrigin: String? = nil,
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
      callers: TrustedCallers(devOrigin: devOrigin))
  }

  /// Sends a request as the bundled web app does, unless `origin` says otherwise.
  private func post(
    _ route: IPCRoute, command: String, body: String = "{}",
    headers: [String: String] = ["Content-Type": "application/json"],
    origin: String? = nil, referer: String? = "reflect-app://localhost/index.html"
  ) async -> FakeSchemeTask {
    var headers = headers
    headers["Origin"] = origin
    headers["Referer"] = referer
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
    let commands: [ShellCommandName: ShellCommand] = [
      .iapPurchase: { _ in
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
      headers: ["Content-Type": "Application/Octet-Stream", "X-Upload-Id": "u1"])

    XCTAssertEqual(calls.first?.args, "")
    XCTAssertEqual(calls.first?.body, Data("raw".utf8))
    XCTAssertEqual(calls.first?.headers["x-upload-id"], "u1")
    XCTAssertEqual(fake.header("Content-Type"), "application/octet-stream")
    XCTAssertEqual(fake.body, Data([1, 2, 3]))
  }

  func testErrorReplyIsFlaggedWithStatus200() async {
    let error = CoreReply.error(.notFound(.init(message: "missing")))
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
      path: "/__ipc/slow", method: "POST",
      headers: [
        "Content-Type": "application/json", "Referer": "reflect-app://localhost/index.html",
      ],
      body: Data("{}".utf8))
    let task = SchemeTask(fake)
    route(gate: gate).start(task)

    task.stop()
    gate.open()
    let deadline = Date().addingTimeInterval(5)
    while calls.isEmpty, Date() < deadline {
      await Task.yield()
    }
    XCTAssertEqual(calls.count, 1)
    for _ in 0..<10 {
      await Task.yield()
    }

    XCTAssertTrue(fake.isUntouched)
  }

  func testUntrustedCallersRunNothing() async {
    var shellRuns = 0
    let route = route(shellCommands: [
      .hostLog: { _ in
        shellRuns += 1
        return .json(Data("null".utf8))
      }
    ])
    // (Origin, Referer): no header at all, an opaque origin, other pages,
    // and a foreign origin that also shows the app as its referrer.
    let app = "reflect-app://localhost/index.html"
    let callers: [(origin: String?, referer: String?)] = [
      (nil, nil),
      ("null", nil),
      ("null", app),
      ("http://untrusted.example", nil),
      ("http://untrusted.example", app),
      (nil, "http://untrusted.example/page"),
      (nil, "https://platform.twitter.com/embed/Tweet.html"),
      (nil, "reflect-app://other/index.html"),
      (nil, "not a url"),
    ]
    for caller in callers {
      for contentType in ["text/plain", "application/json", "application/octet-stream"] {
        for command in ["settings_save", "host.log"] {
          let fake = await post(
            route, command: command, headers: ["Content-Type": contentType],
            origin: caller.origin, referer: caller.referer)
          XCTAssertEqual(fake.response?.statusCode, 403, "\(caller) \(contentType)")
          XCTAssertNil(fake.header("Access-Control-Allow-Origin"))
          XCTAssertTrue(fake.body.isEmpty)
        }
      }
    }
    XCTAssertEqual(calls, [])
    XCTAssertEqual(shellRuns, 0)
  }

  func testUntrustedPreflightIsRefused() {
    let preflight = FakeSchemeTask(
      path: "/__ipc/graph_open", method: "OPTIONS", headers: ["Origin": "http://untrusted.example"])
    route(devOrigin: "http://localhost:1420").start(SchemeTask(preflight))
    XCTAssertEqual(preflight.response?.statusCode, 403)
    XCTAssertNil(preflight.header("Access-Control-Allow-Origin"))
  }

  func testOnlyJSONAndBinaryBodiesRun() async {
    let route = route()
    for contentType in [
      "text/plain", "application/x-www-form-urlencoded", "multipart/form-data",
      "application/jsonp", "application/octet-stream-x",
    ] {
      let fake = await post(route, command: "settings_save", headers: ["Content-Type": contentType])
      XCTAssertEqual(fake.response?.statusCode, 415, contentType)
    }
    let missing = await post(route, command: "settings_save", headers: [:])
    XCTAssertEqual(missing.response?.statusCode, 415)
    XCTAssertEqual(calls, [])

    let withParameter = await post(
      route, command: "settings_save", headers: ["Content-Type": "application/json; charset=utf-8"])
    XCTAssertEqual(withParameter.response?.statusCode, 200)
    XCTAssertEqual(calls.count, 1)
  }

  func testTheDevOriginGetsCORSHeadersAndPreflight() async {
    let dev = "http://localhost:1420"
    let route = route(devOrigin: dev)
    let preflight = FakeSchemeTask(
      path: "/__ipc/graph_open", method: "OPTIONS", headers: ["Origin": dev])
    route.start(SchemeTask(preflight))
    XCTAssertEqual(preflight.response?.statusCode, 204)
    XCTAssertEqual(preflight.header("Access-Control-Allow-Origin"), dev)
    XCTAssertEqual(calls, [])

    let fake = await post(route, command: "graph_open", origin: dev, referer: "\(dev)/")
    XCTAssertEqual(fake.response?.statusCode, 200)
    XCTAssertEqual(fake.header("Access-Control-Allow-Origin"), dev)
    XCTAssertEqual(fake.header("Access-Control-Expose-Headers"), "x-reflect-response")
    XCTAssertEqual(calls.count, 1)

    let app = await post(route, command: "graph_open")
    XCTAssertEqual(app.response?.statusCode, 200)
    XCTAssertNil(app.header("Access-Control-Allow-Origin"))

    let appWithOrigin = await post(
      route, command: "graph_open", origin: TrustedCallers.appOrigin, referer: nil)
    XCTAssertEqual(appWithOrigin.response?.statusCode, 200)
    XCTAssertEqual(calls.count, 3)
  }

  func testOtherMethodsAreRejected() async {
    let fake = FakeSchemeTask(
      path: "/__ipc/graph_open", method: "GET",
      headers: [
        "Referer": "reflect-app://localhost/index.html", "Content-Type": "application/json",
      ])
    route().start(SchemeTask(fake))
    XCTAssertEqual(fake.response?.statusCode, 400)
    XCTAssertEqual(calls, [])
  }
}
