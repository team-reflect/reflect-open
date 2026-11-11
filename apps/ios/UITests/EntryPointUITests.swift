import XCTest

/// The app answers the entry points of the system: `reflect://` URLs.
@MainActor
final class EntryPointUITests: XCTestCase {
  private let app = XCUIApplication()

  override func setUp() async throws {
    continueAfterFailure = false
  }

  /// The search field of the Tasks screen.
  private var tasksSearchField: XCUIElement {
    app.webViews.searchFields["Search tasks"]
  }

  func testAURLNavigatesARunningApp() throws {
    _ = app.launchIntoDailyNote()
    app.open(try XCTUnwrap(URL(string: "reflect://tasks")))
    XCTAssertTrue(tasksSearchField.waitForExistence(timeout: 15))
  }

  func testAURLNavigatesAtLaunch() throws {
    // The first launch creates the graph; a URL then starts the app again.
    _ = app.launchIntoDailyNote()
    app.terminate()
    app.open(try XCTUnwrap(URL(string: "reflect://tasks")))
    XCTAssertTrue(tasksSearchField.waitForExistence(timeout: 30))
  }

  func testTheRecordAudioURLOpensTheRecorder() throws {
    _ = app.launchIntoDailyNote()
    app.open(try XCTUnwrap(URL(string: "reflect://record-audio")))
    let recorder = app.webViews.descendants(matching: .any)["Audio memo"]
    XCTAssertTrue(recorder.waitForExistence(timeout: 15))
    // The page confirms the request to the shell two seconds after it opens
    // the recorder. Until then the shell repeats the request at the next launch.
    Thread.sleep(forTimeInterval: 3)
  }
}
