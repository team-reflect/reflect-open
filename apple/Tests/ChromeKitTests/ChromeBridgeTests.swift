import Foundation
import XCTest

@testable import ChromeKit

@MainActor
final class ChromeBridgeTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
  }

  private func message(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
  }

  func testDecodesEveryFixtureOfThePage() throws {
    for name in ["daily", "note", "tasks", "none"] {
      let message = try JSONDecoder().decode(ChromeMessage.self, from: try fixture(name))
      guard case .state = message else {
        return XCTFail("\(name) is not a state")
      }
    }
  }

  func testDecodesEveryOtherMessageOfThePage() throws {
    let messages = try JSONDecoder().decode([ChromeMessage].self, from: try fixture("messages"))
    XCTAssertEqual(
      messages, [.transition(started: true), .transition(started: false), .chromeReady])
  }

  func testNamesTheFormattingCommandsOfThePage() throws {
    let ids = try JSONDecoder().decode([String].self, from: try fixture("commands"))
    XCTAssertEqual(FormattingCommand.allCases.map(\.rawValue), ids)
  }

  func testEncodesEveryIntentAsTheFixtureThePageParses() throws {
    let intents: [ChromeIntent] = [
      .back(entryId: 3),
      .tab(.all),
      .action(entryId: 3, id: "gear"),
      .command(.indent),
      .files([IntentFile(name: "Image.png", type: "image/png", data: Data([1, 2, 3]))]),
    ]
    let encoded = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(intents))
    let expected = try JSONSerialization.jsonObject(with: try fixture("intents"))
    XCTAssertEqual(encoded as? NSArray, expected as? NSArray)
  }

  func testDailyFixtureHasTheMonthMenuAndTheGear() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("daily"))
    XCTAssertEqual(state.title, "November 2026")
    XCTAssertEqual(state.routeKind, "today")
    XCTAssertEqual(state.leading.map(\.id), ["today"])
    XCTAssertEqual(state.trailing.first?.icon, "gearshape")
    guard case .action(let current) = state.titleMenu?.first else {
      return XCTFail("no month item")
    }
    XCTAssertTrue(current.checked)
    XCTAssertFalse(current.destructive)
  }

  func testNoteFixtureCarriesTheConfirmationAndTheToolbar() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("note"))
    XCTAssertEqual(state.theme, .dark)
    XCTAssertEqual(state.toolbar?.canAttachFiles, true)
    guard case .section(_, let items) = state.trailing.first?.menu?.last,
      case .action(let delete) = items.first
    else {
      return XCTFail("no delete section")
    }
    XCTAssertTrue(delete.destructive)
    XCTAssertEqual(delete.confirm?.action, "Delete")
  }

  func testIgnoresAStateOlderThanTheLatest() throws {
    let bridge = ChromeBridge()
    var titles: [String?] = []
    bridge.onState = { titles.append($0.title) }
    var newer = try JSONSerialization.jsonObject(with: try fixture("tasks")) as! [String: Any]
    newer["generation"] = 3
    newer["title"] = "new"
    var older = newer
    older["generation"] = 2
    older["title"] = "old"

    bridge.receive(try message(newer))
    bridge.receive(try message(older))

    XCTAssertEqual(titles, ["new"])
    XCTAssertEqual(bridge.state?.generation, 3)
  }

  func testDropsIntentsUntilThePageIsReady() throws {
    let bridge = ChromeBridge()
    var sent: [String] = []
    bridge.send = { sent.append(String(decoding: $0, as: UTF8.self)) }

    bridge.send(.tab(.all))
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.send(.action(entryId: 4, id: "pin"))

    XCTAssertEqual(sent.count, 1)
    let intent = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as! [String: Any]
    XCTAssertEqual(intent["type"] as? String, "action")
    XCTAssertEqual(intent["entryId"] as? Int, 4)
    XCTAssertEqual(intent["id"] as? String, "pin")
  }

  func testANewDocumentResetsTheStateAndTheIntentGate() throws {
    let bridge = ChromeBridge()
    var resets = 0
    bridge.onReset = { resets += 1 }
    var sent = 0
    bridge.send = { _ in sent += 1 }
    bridge.receive(try fixture("tasks"))
    bridge.receive(try message(["type": "chromeReady"]))

    bridge.documentDidStart()
    bridge.send(.tab(.daily))

    XCTAssertNil(bridge.state)
    XCTAssertEqual(resets, 1)
    XCTAssertEqual(sent, 0)
  }

  func testTakesAnObjectBodyOfTheScriptMessageHandler() {
    let bridge = ChromeBridge()
    var transitions: [Bool] = []
    bridge.onTransition = { transitions.append($0) }

    bridge.receive(body: ["type": "transition", "phase": "start"])
    bridge.receive(body: #"{"type":"transition","phase":"end"}"#)

    XCTAssertEqual(transitions, [true, false])
  }

  func testReportsTransitions() throws {
    let bridge = ChromeBridge()
    var transitions: [Bool] = []
    bridge.onTransition = { transitions.append($0) }

    bridge.receive(try message(["type": "transition", "phase": "start"]))
    bridge.receive(try message(["type": "transition", "phase": "end"]))

    XCTAssertEqual(transitions, [true, false])
  }

  func testReportsAMessageItCannotDecode() throws {
    let bridge = ChromeBridge()
    var errors = 0
    bridge.onError = { _ in errors += 1 }
    bridge.receive(try message(["type": "unknown"]))
    XCTAssertEqual(errors, 1)
  }
}
