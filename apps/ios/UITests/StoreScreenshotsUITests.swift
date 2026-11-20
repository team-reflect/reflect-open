import XCTest

/// Takes the raw screens of the App Store screenshots. Runs only from
/// `pnpm store-screenshots`, which passes, through `TEST_RUNNER_` variables:
///
/// - `STORE_SCREENSHOTS_FIXTURE`: the path of the `UITestFixture` JSON.
/// - `STORE_SCREENSHOTS_DIR`: the directory that gets one PNG per screen.
@MainActor
final class StoreScreenshotsUITests: XCTestCase {
  private let app = XCUIApplication()
  private var directory = URL(fileURLWithPath: "/")

  override func setUp() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let fixture = environment["STORE_SCREENSHOTS_FIXTURE"],
      let directory = environment["STORE_SCREENSHOTS_DIR"]
    else {
      throw XCTSkip("Runs only from `pnpm store-screenshots`")
    }
    continueAfterFailure = false
    self.directory = URL(fileURLWithPath: directory)
    app.useSession(UUID())
    app.launchEnvironment["REFLECT_UITEST_FIXTURE"] = fixture
  }

  func testScreens() throws {
    app.launch()
    _ = app.waitForDailyNote()
    try snap("daily")
  }

  /// Saves the screen as `<name>.png`, and the element tree as `<name>.txt`.
  private func snap(_ name: String) throws {
    try XCUIScreen.main.screenshot().pngRepresentation
      .write(to: directory.appendingPathComponent("\(name).png"))
    try Data(app.debugDescription.utf8).write(to: directory.appendingPathComponent("\(name).txt"))
  }
}
