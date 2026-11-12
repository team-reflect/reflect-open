import XCTest

extension XCUIApplication {
  /// The time that a test waits for the app to show something. A new
  /// simulator can take minutes to start an app for the first time. A wait
  /// ends as soon as its condition is true, so a fast machine does not wait.
  static let patience: TimeInterval = 180

  /// Gives the app its own data for `session`: the app starts as an install
  /// that finished onboarding with storage on this device (see
  /// `AppDirectories`). Each launch with the same `session` opens the same data.
  func useSession(_ session: UUID) {
    launchEnvironment["REFLECT_UITEST_SESSION"] = session.uuidString
    launchEnvironment["RUST_LOG"] = "info"
  }

  /// Waits for the editor of today's note in an app that is starting.
  func waitForDailyNote() -> XCUIElement {
    let editor = webViews.textViews.firstMatch
    XCTAssertTrue(
      editor.waitForExistence(timeout: Self.patience), "today's note has an editor")
    return editor
  }
}
