import XCTest

/// Drives the real app from outside: the web app starts, takes keyboard
/// input, saves it, and survives a relaunch and a trip to the background.
@MainActor
final class SmokeUITests: XCTestCase {
  private let app = XCUIApplication()

  override func setUp() async throws {
    continueAfterFailure = false
  }

  private func waitForText(_ text: String, in editor: XCUIElement) {
    let hasText = NSPredicate { element, _ in
      ((element as? XCUIElement)?.value as? String)?.contains(text) ?? false
    }
    wait(for: [expectation(for: hasText, evaluatedWith: editor)], timeout: 15)
  }

  func testTypedTextSurvivesARelaunch() {
    let token = "uitest\(Int(Date().timeIntervalSince1970))"
    let editor = app.launchIntoDailyNote()
    editor.tap()
    editor.typeText("\(token) ")
    waitForText(token, in: editor)
    // The save is debounced.
    Thread.sleep(forTimeInterval: 2)

    app.terminate()
    waitForText(token, in: app.launchIntoDailyNote())
  }

  func testThePageSurvivesTheBackground() {
    let editor = app.launchIntoDailyNote()
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertTrue(app.webViews.buttons["Daily"].waitForExistence(timeout: 10))
  }
}
