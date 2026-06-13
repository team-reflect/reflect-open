import SwiftRs
import Tauri
import UIKit
import WebKit

class ShareArgs: Decodable {
  let text: String
  let title: String?
}

/// Presents the system share sheet (`UIActivityViewController`) for a piece
/// of text — Reflect's mobile "Share note" action (Plan 19). The webview
/// hands over the note's markdown; iOS owns the target list (Messages, Mail,
/// Notes, Copy, …).
class SharesheetPlugin: Plugin {
  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)

    DispatchQueue.main.async {
      var items: [Any] = [args.text]
      if let title = args.title {
        // Carries through to targets that use a subject (e.g. Mail).
        items.append(ShareTitleSource(title: title, text: args.text))
      }
      let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)

      guard let presenter = Self.topViewController() else {
        invoke.reject("no view controller to present the share sheet from")
        return
      }
      // iPad requires a popover anchor; center it on the presenter's view.
      if let popover = activity.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      presenter.present(activity, animated: true) {
        invoke.resolve()
      }
    }
  }

  /// The frontmost view controller to present from — walks past any already
  /// presented controllers so a second share doesn't try to present on a
  /// busy one.
  private static func topViewController() -> UIViewController? {
    let keyWindow = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// Supplies a subject line to share targets that ask for one, while the
/// shared item itself stays the plain text.
private class ShareTitleSource: NSObject, UIActivityItemSource {
  let title: String
  let text: String

  init(title: String, text: String) {
    self.title = title
    self.text = text
  }

  func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any {
    text
  }

  func activityViewController(
    _ controller: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?
  ) -> Any? {
    nil
  }

  func activityViewController(
    _ controller: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?
  ) -> String {
    title
  }
}

@_cdecl("init_plugin_sharesheet")
func initPlugin() -> Plugin {
  return SharesheetPlugin()
}
