import XCTest

/// Drives the real app from outside along one path: the web app starts,
/// takes keyboard input and saves it. A `reflect://` URL then starts the app
/// again on its page, and a second URL shows the saved text in the running app.
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

  func testTypedTextSurvivesARelaunchAndURLsOpenTheirPages() throws {
    let token = "uitest\(UUID().uuidString.prefix(8).lowercased())"
    app.launch()
    let editor = app.waitForDailyNote()
    editor.tap()
    editor.typeText("\(token) ")
    waitForText(token, in: editor)

    // The page saves 0.8 s after the last key, and again when the app goes to
    // the background. The app shows no sign of a finished save, so the test
    // has none to wait for.
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: XCUIApplication.patience))
    app.terminate()

    // A URL starts the app: the page gets the URL when it is ready.
    app.open(try XCTUnwrap(URL(string: "reflect://tasks")))
    XCTAssertTrue(
      app.webViews.searchFields["Search tasks"].waitForExistence(
        timeout: XCUIApplication.patience))

    // A URL reaches the running app: today's note has the text from before.
    app.open(try XCTUnwrap(URL(string: "reflect://today")))
    waitForText(token, in: app.waitForDailyNote())
  }
}
