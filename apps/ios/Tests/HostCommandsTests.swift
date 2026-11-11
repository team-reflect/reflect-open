import XCTest

@testable import Reflect

@MainActor
final class HostCommandsTests: XCTestCase {
  private var opened: [URL] = []

  private func run(_ command: String, _ args: String, canOpen: Bool = true) async -> CoreReply {
    let deepLinks = DeepLinks { _, _ in }
    deepLinks.open([URL(string: "reflect://note/a") ?? URL(fileURLWithPath: "/")])
    let commands = HostCommands.all(deepLinks: deepLinks) { [weak self] url in
      self?.opened.append(url)
      return canOpen
    }
    guard let shellCommand = commands[command] else {
      return .error(kind: "notFound", message: command)
    }
    return await shellCommand(ShellRequest(args: Data(args.utf8), headers: [:], body: Data()))
  }

  private func kind(_ reply: CoreReply) -> String? {
    guard case .error(let json) = reply else { return nil }
    return (try? JSONSerialization.jsonObject(with: json) as? [String: String])?["kind"]
  }

  func testOpenURLHandsTheURLToTheSystem() async {
    let reply = await run("host.open_url", #"{"url":"https://reflect.app/a?b=1"}"#)
    XCTAssertEqual(reply, .json(Data("null".utf8)))
    XCTAssertEqual(opened.map(\.absoluteString), ["https://reflect.app/a?b=1"])
  }

  func testOpenURLReportsARefusal() async {
    let refused = await run("host.open_url", #"{"url":"nosuchscheme://x"}"#, canOpen: false)
    XCTAssertEqual(kind(refused), "io")
    let relative = await run("host.open_url", #"{"url":"not a url"}"#)
    XCTAssertEqual(kind(relative), "parse")
    XCTAssertEqual(opened.count, 1)
  }

  func testDeepLinkPendingAnswersTheLaunchURLs() async {
    let reply = await run("host.deep_link_pending", "{}")
    XCTAssertEqual(reply, .json(Data(#"["reflect:\/\/note\/a"]"#.utf8)))
  }

  func testLogChecksItsArguments() async {
    let ok = await run("host.log", #"{"level":"warn","message":"m"}"#)
    XCTAssertEqual(ok, .json(Data("null".utf8)))
    let bad = await run("host.log", #"{"level":"warn"}"#)
    XCTAssertEqual(kind(bad), "parse")
  }
}
