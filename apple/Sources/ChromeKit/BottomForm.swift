public import CoreGraphics

/// Where the shell draws the tab capsule and the `+`.
public enum BottomForm: Equatable, Sendable {
  /// The iPhone: the capsule at the bottom-leading edge, the `+` on its row at
  /// the trailing edge.
  case bar
  /// The iPhone Duo: the system's vertical tab rail at the trailing edge, the
  /// `+` above it.
  case rail
  /// The iPad: the system's tab bar at the top, the `+` in the bottom-right
  /// corner.
  case pad

  /// The form for a window of regular width on an iPad (`regularPad`), or for
  /// the frame the system gives its tab bar. The system lays the tab bar out
  /// as a vertical rail on an iPhone Duo, and keeps that frame while the bar
  /// is hidden.
  public static func resolve(regularPad: Bool, tabBarFrame: CGRect) -> BottomForm {
    if regularPad {
      return .pad
    }
    return tabBarFrame.height > tabBarFrame.width ? .rail : .bar
  }
}
