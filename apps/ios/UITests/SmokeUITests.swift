import XCTest

/// Drives the real app from outside: the web app starts, takes keyboard
/// input, saves it, and survives a relaunch and a trip to the background.
@MainActor
final class SmokeUITests: XCTestCase {
  private let app = XCUIApplication()

  override func setUp() async throws {
    continueAfterFailure = false
  }

  /// Launches the app and returns the editor of today's note. A fresh
  /// install shows onboarding first: this picks local storage.
  private func launchIntoDailyNote() -> XCUIElement {
    app.launch()
    let webView = app.webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 30), "the web view exists")
    let editor = webView.textViews.firstMatch
    let useLocalStorage = webView.buttons["Or, use this device only"]
    if !editor.waitForExistence(timeout: 10), useLocalStorage.exists {
      useLocalStorage.tap()
    }
    XCTAssertTrue(editor.waitForExistence(timeout: 30), "today's note has an editor")
    return editor
  }

  private func waitForText(_ text: String, in editor: XCUIElement) {
    let hasText = NSPredicate { element, _ in
      ((element as? XCUIElement)?.value as? String)?.contains(text) ?? false
    }
    wait(for: [expectation(for: hasText, evaluatedWith: editor)], timeout: 15)
  }

  func testTypedTextSurvivesARelaunch() {
    let token = "uitest\(Int(Date().timeIntervalSince1970))"
    let editor = launchIntoDailyNote()
    editor.tap()
    editor.typeText("\(token) ")
    waitForText(token, in: editor)
    // The save is debounced.
    Thread.sleep(forTimeInterval: 2)

    app.terminate()
    waitForText(token, in: launchIntoDailyNote())
  }

  func testThePageSurvivesTheBackground() {
    let editor = launchIntoDailyNote()
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertTrue(app.webViews.buttons["Daily"].exists)
  }
}
