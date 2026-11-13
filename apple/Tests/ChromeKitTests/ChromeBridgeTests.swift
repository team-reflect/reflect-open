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
      messages,
      [
        .transition(started: true), .transition(started: false), .backSwipe(started: true),
        .backSwipe(started: false), .chromeReady,
      ])
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
      .layout(cornersInHeaderRow: false),
      .plus(entryId: 3, command: .note),
      .sidebarVisible(true),
      .sidebarVisible(nil),
      .sidebar(.chat),
      .sidebar(.search),
      .sidebar(.settings),
      .sidebar(.openNote("reflect-v2.md")),
      .sidebar(.unpin("reflect-v2.md")),
      .sidebar(.share("reflect-v2.md")),
      .sidebar(.menu("graphs")),
    ]
    let encoded = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(intents))
    let expected = try JSONSerialization.jsonObject(with: try fixture("intents"))
    XCTAssertEqual(encoded as? NSArray, expected as? NSArray)
  }

  func testDailyFixtureHasTheGearAndTheTodayButton() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("daily"))
    XCTAssertEqual(state.routeKind, "today")
    XCTAssertEqual(state.leading.first?.icon, "gearshape")
    XCTAssertEqual(state.trailing.map(\.id), ["today"])
  }

  func testFixturesCarryThePlusOfTheScreen() throws {
    let decoder = JSONDecoder()
    XCTAssertEqual(
      try decoder.decode(ChromeState.self, from: try fixture("daily")).plus,
      .capture(audio: .idle))
    XCTAssertEqual(
      try decoder.decode(ChromeState.self, from: try fixture("tasks")).plus,
      .action(label: "New task"))
    XCTAssertNil(try decoder.decode(ChromeState.self, from: try fixture("none")).plus)
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
    var entries: [Int] = []
    bridge.onState = { entries.append($0.entryId) }
    var newer = try JSONSerialization.jsonObject(with: try fixture("tasks")) as! [String: Any]
    newer["generation"] = 3
    newer["entryId"] = 30
    var older = newer
    older["generation"] = 2
    older["entryId"] = 20

    bridge.receive(try message(newer))
    bridge.receive(try message(older))

    XCTAssertEqual(entries, [30])
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

  func testSendsTheLayoutWhenItChangesAndToANewPage() throws {
    let bridge = ChromeBridge()
    var sent: [ChromeIntent] = []
    bridge.send = { data in
      let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      sent.append(.layout(cornersInHeaderRow: object["cornersInHeaderRow"] as! Bool))
    }

    bridge.cornersInHeaderRow = false
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.cornersInHeaderRow = false
    bridge.cornersInHeaderRow = true
    bridge.documentDidStart()
    bridge.receive(try message(["type": "chromeReady"]))

    XCTAssertEqual(sent, [.layout(cornersInHeaderRow: false), .layout(cornersInHeaderRow: true)])
  }

  func testSendsTheSidebarVisibilityWhenItChangesAndToANewPage() throws {
    let bridge = ChromeBridge()
    var sent: [Bool?] = []
    bridge.send = { data in
      let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      sent.append(object["visible"] as? Bool)
    }

    bridge.sidebarVisible = true
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.sidebarVisible = true
    bridge.sidebarVisible = false
    bridge.documentDidStart()
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.sidebarVisible = nil

    XCTAssertEqual(sent, [true, false, false, nil])
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

  func testReportsBackSwipes() throws {
    let bridge = ChromeBridge()
    var swipes: [Bool] = []
    bridge.onBackSwipe = { swipes.append($0) }

    bridge.receive(try message(["type": "backSwipe", "phase": "start"]))
    bridge.receive(try message(["type": "backSwipe", "phase": "cancel"]))

    XCTAssertEqual(swipes, [true, false])
  }

  func testReportsAMessageItCannotDecode() throws {
    let bridge = ChromeBridge()
    var errors = 0
    bridge.onError = { _ in errors += 1 }
    bridge.receive(try message(["type": "unknown"]))
    XCTAssertEqual(errors, 1)
  }
}
