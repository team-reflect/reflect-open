import XCTest

extension XCUIApplication {
  /// Launches the app and returns the editor of today's note.
  func launchIntoDailyNote() -> XCUIElement {
    launch()
    return waitForDailyNote()
  }

  /// Waits for the editor of today's note in an app that is starting. A
  /// fresh install shows onboarding first: this picks local storage.
  func waitForDailyNote() -> XCUIElement {
    let webView = webViews.firstMatch
    XCTAssertTrue(webView.waitForExistence(timeout: 30), "the web view exists")
    let editor = webView.textViews.firstMatch
    let useLocalStorage = webView.buttons["Or, use this device only"]
    if !editor.waitForExistence(timeout: 10), useLocalStorage.exists {
      useLocalStorage.tap()
    }
    XCTAssertTrue(editor.waitForExistence(timeout: 30), "today's note has an editor")
    return editor
  }
}
