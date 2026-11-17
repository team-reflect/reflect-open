import TypesShared
import UIKit
import WebHostKit

/// The `plugin:mobile-haptics` commands. A web view has no `navigator.vibrate`,
/// so the web app asks the shell for each haptic.
@MainActor
enum HapticsCapability {
  private static let lightImpact = UIImpactFeedbackGenerator(style: .light)

  static let commands: [ShellCommandName: ShellCommand] = [
    .hapticsImpactLight: { _ in
      lightImpact.impactOccurred()
      return .null
    }
  ]
}
