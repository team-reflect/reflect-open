import UIKit

/// Shows one full-screen `ReflectWebView` with the web app, or the error of a
/// shell that did not start.
@MainActor
final class RootViewController: UIViewController {
  private(set) var host: AppHost?

  override func loadView() {
    do {
      let host = try AppHost()
      self.host = host
      view = host.webView
    } catch {
      let label = UILabel()
      label.text = "Reflect could not start.\n\(error)"
      label.numberOfLines = 0
      label.textAlignment = .center
      label.backgroundColor = .systemBackground
      view = label
    }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    if let host {
      host.webView.load(URLRequest(url: host.startURL))
    }
  }
}
