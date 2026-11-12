import SwiftUI
import UIKit

/// The extension's principal class (`NSExtensionPrincipalClass` — the
/// `@objc` name pins what the Info.plist references). Storyboard-less: it
/// hosts the SwiftUI `ShareView`, and the save flow starts as soon as the
/// sheet appears.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private let state = ShareState()

  override func viewDidLoad() {
    super.viewDidLoad()
    state.extensionContext = extensionContext
    view.backgroundColor = .systemBackground

    let hosting = UIHostingController(rootView: ShareView().environmentObject(state))
    addChild(hosting)
    hosting.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hosting.view)
    NSLayoutConstraint.activate([
      hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    hosting.didMove(toParent: self)
  }
}
