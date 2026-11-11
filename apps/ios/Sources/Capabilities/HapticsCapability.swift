import UIKit

/// The `plugin:mobile-haptics` commands. A web view has no `navigator.vibrate`,
/// so the web app asks the shell for each haptic.
@MainActor
enum HapticsCapability {
  private static let lightImpact = UIImpactFeedbackGenerator(style: .light)

  static let commands: [String: ShellCommand] = [
    "plugin:mobile-haptics|impact_light": { _ in
      lightImpact.impactOccurred()
      return .null
    }
  ]
}
