import Foundation
import XCTest

@testable import ChromeKit

final class MenuItemTests: XCTestCase {
  private func items(_ json: String) throws -> [MenuItem] {
    try JSONDecoder().decode([MenuItem].self, from: Data(json.utf8))
  }

  private func checked(_ items: [MenuItem]) -> [String: Bool] {
    var result: [String: Bool] = [:]
    for item in items {
      switch item {
      case .action(let action): result[action.id] = action.checked
      case .section(_, let items): result.merge(checked(items)) { $1 }
      }
    }
    return result
  }

  func testFlipsOnlyTheCheckmarkOfTheTappedAction() throws {
    let menu = try items(
      """
      [
        {"type": "action", "id": "pinned", "title": "Pinned", "checked": true},
        {"type": "action", "id": "current", "title": "Current"},
        {"type": "section", "items": [
          {"type": "action", "id": "archived", "title": "Show archived"}
        ]}
      ]
      """)

    let afterArchived = menu.map { $0.togglingCheckmark(of: "archived") }
    XCTAssertEqual(checked(afterArchived), ["pinned": true, "current": false, "archived": true])

    let afterPinned = afterArchived.map { $0.togglingCheckmark(of: "pinned") }
    XCTAssertEqual(checked(afterPinned), ["pinned": false, "current": false, "archived": true])
  }
}
