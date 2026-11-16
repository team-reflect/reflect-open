import Foundation
import TypesShared
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
        .backSwipe(.init(phase: .start)), .backSwipe(.init(phase: .cancel)), .chromeReady,
        .focusSearch(.init(entryId: 3)),
      ])
  }

  func testEncodesEveryIntentAsTheFixtureThePageParses() throws {
    let intents: [ChromeIntent] = [
      .back(.init(entryId: 3)),
      .tab(.init(tab: .all)),
      .action(.init(entryId: 3, id: "gear")),
      .command(.init(id: .indent)),
      .files(
        .init(files: [IntentFile(name: "Image.png", type: "image/png", bytes: Data([1, 2, 3]))])),
      .windowControls(.init(width: 88)),
      .plus(.init(entryId: 3, command: .note)),
      .sidebarVisible(.init(visible: true)),
      .sidebarVisible(.init(visible: nil)),
      .history(.init(entryId: 3, direction: .back)),
      .history(.init(entryId: 3, direction: .forward)),
      .sidebar(.init(command: .chat)),
      .sidebar(.init(command: .search)),
      .sidebar(.init(command: .settings)),
      .sidebar(.init(command: .openNote(.init(path: "reflect-v2.md")))),
      .sidebar(.init(command: .unpin(.init(path: "reflect-v2.md")))),
      .sidebar(.init(command: .share(.init(path: "reflect-v2.md")))),
      .sidebar(.init(command: .menu(.init(id: "graphs")))),
      .search(.init(entryId: 3, text: "meet")),
      .pickMonth(.init(entryId: 3, month: "2026-08")),
    ]
    let encoded = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(intents))
    let expected = try JSONSerialization.jsonObject(with: try fixture("intents"))
    XCTAssertEqual(encoded as? NSArray, expected as? NSArray)
  }

  func testDailyFixtureHasTheGearAndTheTodayButton() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("daily"))
    XCTAssertEqual(state.routeKind, "today")
    XCTAssertEqual(state.history?.back, true)
    XCTAssertEqual(state.history?.forward, false)
    XCTAssertEqual(state.leading.first?.icon, "gearshape")
    XCTAssertEqual(state.trailing.map(\.id), ["today"])
    XCTAssertEqual(state.title, .month(.init(text: "November 2026", month: "2026-11")))
  }

  func testTasksFixtureCarriesTheSearchField() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("tasks"))
    XCTAssertEqual(state.search?.placeholder, "Search tasks…")
    XCTAssertEqual(state.search?.revision, 0)
    XCTAssertEqual(state.trailing.map(\.icon), ["slider.horizontal.3"])
  }

  func testCallsFocusSearchWithTheEntry() throws {
    let bridge = ChromeBridge()
    var focused: [Int] = []
    bridge.onFocusSearch = { focused.append($0) }
    bridge.receive(try message(["type": "focusSearch", "entryId": 7]))
    XCTAssertEqual(focused, [7])
  }

  func testFixturesCarryThePlusOfTheScreen() throws {
    let decoder = JSONDecoder()
    XCTAssertEqual(
      try decoder.decode(ChromeState.self, from: try fixture("daily")).plus,
      .capture(.init(audio: .idle)))
    XCTAssertEqual(
      try decoder.decode(ChromeState.self, from: try fixture("tasks")).plus,
      .action(.init(label: "New task")))
    XCTAssertNil(try decoder.decode(ChromeState.self, from: try fixture("none")).plus)
  }

  func testNoteFixtureCarriesTheConfirmationAndTheToolbar() throws {
    let state = try JSONDecoder().decode(ChromeState.self, from: try fixture("note"))
    XCTAssertEqual(state.theme, .dark)
    XCTAssertEqual(state.toolbar?.canAttachFiles, true)
    guard case .section(let section) = state.trailing.first?.menu?.last,
      case .action(let delete) = section.items.first
    else {
      return XCTFail("no delete section")
    }
    XCTAssertEqual(delete.destructive, true)
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

    bridge.send(.tab(.init(tab: .all)))
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.send(.action(.init(entryId: 4, id: "pin")))

    XCTAssertEqual(sent.count, 1)
    let intent = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as! [String: Any]
    XCTAssertEqual(intent["type"] as? String, "action")
    XCTAssertEqual(intent["entryId"] as? Int, 4)
    XCTAssertEqual(intent["id"] as? String, "pin")
  }

  func testSendsTheWindowControlsWidthWhenItChangesAndToANewPage() throws {
    let bridge = ChromeBridge()
    var sent: [Double] = []
    bridge.send = { data in
      let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      sent.append(object["width"] as! Double)
    }

    bridge.windowControlsWidth = 88
    bridge.receive(try message(["type": "chromeReady"]))
    bridge.windowControlsWidth = 88
    bridge.windowControlsWidth = 0
    bridge.documentDidStart()
    bridge.receive(try message(["type": "chromeReady"]))

    XCTAssertEqual(sent, [88, 0])
  }

  func testSendsTheSidebarVisibilityWhenItChangesAndToANewPage() throws {
    let bridge = ChromeBridge()
    var sent: [Bool?] = []
    bridge.send = { data in
      let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      sent.append(object["visible"] is NSNull ? nil : (object["visible"] as! Bool))
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
    bridge.send(.tab(.init(tab: .daily)))

    XCTAssertNil(bridge.state)
    XCTAssertEqual(resets, 1)
    XCTAssertEqual(sent, 0)
  }

  func testTakesAnObjectBodyOfTheScriptMessageHandler() {
    let bridge = ChromeBridge()
    var swipes: [Bool] = []
    bridge.onBackSwipe = { swipes.append($0) }

    bridge.receive(body: ["type": "backSwipe", "phase": "start"])
    bridge.receive(body: #"{"type":"backSwipe","phase":"cancel"}"#)

    XCTAssertEqual(swipes, [true, false])
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
