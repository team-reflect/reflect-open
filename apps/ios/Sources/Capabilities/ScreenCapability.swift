import TypesShared
import UIKit
import WebHostKit

/// The `plugin:screen` command, and the one owner of the idle timer: the
/// screen stays on while any reason holds it.
@MainActor
final class ScreenCapability {
  enum Reason {
    case recording
    case frontend
  }

  private var reasons: Set<Reason> = []

  func setKeepAwake(_ keepAwake: Bool, for reason: Reason) {
    if keepAwake {
      reasons.insert(reason)
    } else {
      reasons.remove(reason)
    }
    UIApplication.shared.isIdleTimerDisabled = !reasons.isEmpty
  }

  var commands: [ShellCommandName: ShellCommand] {
    [
      .screenKeepAwake: { [self] request in
        guard let args = request.decodeArgs(ScreenKeepAwakeArgs.self) else {
          return .error(.parse(.init(message: "keep_awake takes {keepAwake}")))
        }
        setKeepAwake(args.keepAwake, for: .frontend)
        return .null
      }
    ]
  }
}
