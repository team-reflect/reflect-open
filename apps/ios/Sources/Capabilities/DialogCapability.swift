import TypesShared
import UIKit
import WebHostKit

/// The `plugin:mobile-dialog` command: a system alert with a title, a message,
/// and two buttons. A web view shows no alert for `window.confirm` by itself.
@MainActor
final class DialogCapability {
  private let presenter: @MainActor () -> UIViewController?

  /// `presenter` returns the view controller that presents the alert.
  init(presenter: @escaping @MainActor () -> UIViewController?) {
    self.presenter = presenter
  }

  var commands: [ShellCommandName: ShellCommand] {
    [.dialogConfirm: { [self] request in await confirm(request) }]
  }

  /// `confirm {title, message, confirm, cancel}`: answers whether the user
  /// chose `confirm`.
  private func confirm(_ request: ShellRequest) async -> CoreReply {
    guard let args = request.decodeArgs(DialogConfirmArgs.self) else {
      return .error(.parse(.init(message: "confirm takes {title, message, confirm, cancel}")))
    }
    guard var top = presenter() else {
      return .error(.io(.init(message: "no window presents the alert")))
    }
    while let presented = top.presentedViewController {
      top = presented
    }
    let alert = UIAlertController(
      title: args.title, message: args.message, preferredStyle: .alert)
    let confirmed = await withCheckedContinuation { continuation in
      alert.addAction(
        UIAlertAction(title: args.cancel, style: .cancel) { _ in continuation.resume(returning: false) })
      let confirm = UIAlertAction(title: args.confirm, style: .default) { _ in
        continuation.resume(returning: true)
      }
      alert.addAction(confirm)
      alert.preferredAction = confirm
      top.present(alert, animated: true)
    }
    return .value(confirmed)
  }
}
