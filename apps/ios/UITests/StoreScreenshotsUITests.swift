import XCTest

/// Takes the raw screens of the App Store screenshots. Runs only from
/// `pnpm store-screenshots`, which passes, through `TEST_RUNNER_` variables:
///
/// - `STORE_SCREENSHOTS_FIXTURE`: the path of the `UITestFixture` JSON.
/// - `STORE_SCREENSHOTS_DIR`: the directory that gets one PNG per screen.
///
/// The texts that the test waits for come from
/// `apps/ios/store-screenshots/fixture.ts`.
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
    try snap("daily", when: "30 minute run along the river")

    try open("reflect://note/notes/ava-patel.md")
    try snap("note", when: "Incoming backlinks")

    try open("reflect://search?q=kyoto")
    try snap("search", when: "Arashiyama")

    try open("reflect://search?q=What%20does%20Ava%20want%20for%20the%20rebrand%3F")
    element(containing: "Ask “What does Ava want").tap()
    try snap("chat", when: "land best")

    try open("reflect://tasks")
    try snap("tasks", when: "Present three directions")
  }

  private func open(_ url: String) throws {
    app.open(try XCTUnwrap(URL(string: url)))
  }

  /// The first element whose label contains `text`, in the native chrome or the web view.
  private func element(containing text: String) -> XCUIElement {
    let element = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    XCTAssertTrue(element.waitForExistence(timeout: XCUIApplication.patience), "shows \(text)")
    return element
  }

  /// Saves the screen as `<name>.png` once it shows `text`.
  private func snap(_ name: String, when text: String) throws {
    _ = element(containing: text)
    // The text can show while a push or a tab change still moves the screen,
    // and no element reports the end of the animation.
    Thread.sleep(forTimeInterval: 1)
    try screenshot().pngRepresentation
      .write(to: directory.appendingPathComponent("\(name).png"))
  }

  /// The screen of the app. An open iPhone Duo has two screens, and
  /// `XCUIScreen.main` is the outer one, so it is the screen with the shape
  /// of the app's window: the ratio of the short side to the long side, as
  /// the image of the inner screen is portrait with a landscape tag.
  private func screenshot() -> XCUIScreenshot {
    let shape = { (width: CGFloat, height: CGFloat) in min(width, height) / max(width, height) }
    let window = app.windows.firstMatch.frame.size
    let shots = XCUIScreen.screens.map { $0.screenshot() }
    return shots.first { shot in
      guard let image = shot.image.cgImage else { return false }
      return abs(
        shape(CGFloat(image.width), CGFloat(image.height)) - shape(window.width, window.height))
        < 0.005
    } ?? XCUIScreen.main.screenshot()
  }
}
