import XCTest

/// Drives the real app from outside along one path: the web app starts,
/// takes keyboard input, saves it, shows it again after a relaunch, and opens
/// the page of a `reflect://` URL.
@MainActor
final class GoldenPathUITests: XCTestCase {
  private let app = XCUIApplication()

  override func setUp() async throws {
    continueAfterFailure = false
    app.useSession(UUID())
  }

  private func waitForText(_ text: String, in editor: XCUIElement) {
    let hasText = NSPredicate { element, _ in
      ((element as? XCUIElement)?.value as? String)?.contains(text) ?? false
    }
    wait(
      for: [expectation(for: hasText, evaluatedWith: editor)], timeout: XCUIApplication.patience)
  }

  func testTypedTextSurvivesARelaunchAndAURLOpensItsPage() throws {
    let token = "uitest\(UUID().uuidString.prefix(8).lowercased())"
    app.launch()
    let editor = app.waitForDailyNote()
    editor.tap()
    editor.typeText("\(token) ")
    waitForText(token, in: editor)

    // The app goes to the background before the system ends it.
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: XCUIApplication.patience))
    app.terminate()

    app.launch()
    waitForText(token, in: app.waitForDailyNote())

    app.open(try XCTUnwrap(URL(string: "reflect://tasks")))
    XCTAssertTrue(
      app.webViews.searchFields["Search tasks"].waitForExistence(
        timeout: XCUIApplication.patience))
  }
}
