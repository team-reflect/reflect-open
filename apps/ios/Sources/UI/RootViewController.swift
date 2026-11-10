import UIKit

/// Shows one full-screen `ReflectWebView`. It loads the bundled web app, or
/// the URL in the `REFLECT_DEV_URL` environment variable when that is set.
@MainActor
final class RootViewController: UIViewController {
  private let webView = ReflectWebView()

  override func loadView() {
    view = webView
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    let devURL = ProcessInfo.processInfo.environment["REFLECT_DEV_URL"]
    if let url = URL(string: devURL ?? AppSchemeHandler.indexURL) {
      webView.load(URLRequest(url: url))
    }
  }
}
