import UIKit

/// Shows the web app in the native chrome containers, or the error of a
/// shell that did not start.
@MainActor
final class RootViewController: UIViewController {
  private(set) var host: AppHost?
  private var chrome: ChromeCoordinator?

  override func loadView() {
    do {
      let host = try AppHost()
      self.host = host
      let view = UIView()
      view.backgroundColor = .systemBackground
      self.view = view
      let chrome = ChromeCoordinator(host: host)
      self.chrome = chrome
      embed(chrome.container)
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

  override func viewWillTransition(
    to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator
  ) {
    super.viewWillTransition(to: size, with: coordinator)
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in
      self?.chrome?.sizeDidChange()
    }
  }

  override var childForStatusBarStyle: UIViewController? {
    children.first
  }

  /// Adds `child` edge to edge.
  private func embed(_ child: UIViewController) {
    addChild(child)
    child.view.frame = view.bounds
    child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(child.view)
    child.didMove(toParent: self)
  }
}
