import XCTest

/// Drives the real app from outside: the web app starts, takes keyboard
/// input, saves it, and survives a trip to the background and a relaunch.
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
    wait(for: [expectation(for: hasText, evaluatedWith: editor)], timeout: 60)
  }

  func testTypedTextSurvivesTheBackgroundAndARelaunch() {
    let token = "uitest\(Int(Date().timeIntervalSince1970))"
    let editor = app.launchIntoDailyNote()
    editor.tap()
    editor.typeText("\(token) ")
    waitForText(token, in: editor)

    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    waitForText(token, in: editor)

    app.terminate()
    waitForText(token, in: app.launchIntoDailyNote())
  }
}
