import XCTest

/// The app answers the entry points of the system: `reflect://` URLs.
///
/// The Nightly test plan runs this test. The Reflect test plan skips it:
/// `GoldenPathUITests` opens one URL in the running app.
@MainActor
final class EntryPointUITests: XCTestCase {
  private let app = XCUIApplication()

  override func setUp() async throws {
    continueAfterFailure = false
    app.useSession(UUID())
  }

  func testURLsReachTheAppAtLaunchAndWhileItRuns() throws {
    // The first launch creates the graph; a URL then starts the app again.
    app.launch()
    _ = app.waitForDailyNote()
    app.terminate()
    app.open(try XCTUnwrap(URL(string: "reflect://tasks")))
    XCTAssertTrue(
      app.webViews.searchFields["Search tasks"].waitForExistence(
        timeout: XCUIApplication.patience))

    app.open(try XCTUnwrap(URL(string: "reflect://record-audio")))
    let recorder = app.webViews.descendants(matching: .any)["Audio memo"]
    XCTAssertTrue(recorder.waitForExistence(timeout: XCUIApplication.patience))
    // The page confirms the request to the shell two seconds after it opens
    // the recorder. Until then the shell repeats the request at the next launch.
    Thread.sleep(forTimeInterval: 3)
  }
}
