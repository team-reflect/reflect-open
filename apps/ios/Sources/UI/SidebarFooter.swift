import ChromeKit
import UIKit

/// The bottom of the iPad sidebar: the graph button, which opens the graph
/// menu, and the Settings button.
@MainActor
final class SidebarFooter: UIView {
  /// Called with the id of a graph menu item.
  var onMenu: (String) -> Void = { _ in }
  var onSettings: () -> Void = {}

  private let graphButton = UIButton(configuration: .plain())
  private let settingsButton = UIButton(configuration: .plain())

  init() {
    super.init(frame: .zero)
    graphButton.showsMenuAsPrimaryAction = true
    graphButton.contentHorizontalAlignment = .leading
    graphButton.configuration?.imagePadding = 10
    graphButton.configuration?.titleLineBreakMode = .byTruncatingTail
    settingsButton.configuration?.image = UIImage(systemName: "gearshape")
    settingsButton.accessibilityLabel = "Settings"
    settingsButton.tintColor = .secondaryLabel
    settingsButton.addAction(
      UIAction { [weak self] _ in self?.onSettings() }, for: .primaryActionTriggered)
    let row = UIStackView(arrangedSubviews: [graphButton, settingsButton])
    row.alignment = .center
    row.spacing = 4
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    graphButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
    graphButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      row.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -8),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// Shows the graph of `state`.
  func update(_ state: SidebarState) {
    graphButton.configuration?.title = state.graphName
    graphButton.configuration?.baseForegroundColor = .label
    graphButton.configuration?.image = Self.swatch(
      state.graphColor.flatMap(UIColor.init(hex:)) ?? tintColor)
    graphButton.menu = MenuBuilder.menu(state.graphMenu) { [weak self] action in
      self?.onMenu(action.id)
    }
  }

  /// The graph's color as a small rounded square.
  private static func swatch(_ color: UIColor) -> UIImage {
    let size = CGSize(width: 20, height: 20)
    return UIGraphicsImageRenderer(size: size).image { _ in
      color.setFill()
      UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 5).fill()
    }.withRenderingMode(.alwaysOriginal)
  }
}

extension UIColor {
  /// A color from `#rrggbb`.
  fileprivate convenience init?(hex: String) {
    guard hex.hasPrefix("#"), hex.count == 7, let value = Int(hex.dropFirst(), radix: 16) else {
      return nil
    }
    self.init(
      red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255, alpha: 1)
  }
}
