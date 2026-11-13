import ChromeKit
import UIKit

extension ChromeTab {
  var title: String {
    switch self {
    case .daily: "Daily"
    case .all: "All"
    case .tasks: "Tasks"
    }
  }

  var image: UIImage? {
    switch self {
    case .daily: UIImage(systemName: "square.and.pencil")
    case .all: UIImage(systemName: "doc.on.doc")
    case .tasks: Self.outlineSymbol("checkmark.circle")
    }
  }

  /// A template image of a symbol at the tab bar's 23 pt symbol size. The tab
  /// bar shows a symbol's `.fill` variant, but shows a bitmap as it is.
  private static func outlineSymbol(_ name: String) -> UIImage? {
    let configuration = UIImage.SymbolConfiguration(pointSize: 23)
    guard
      let symbol = UIImage(systemName: name, variableValue: 1, configuration: configuration)
    else { return nil }
    let bitmap = UIGraphicsImageRenderer(size: symbol.size).image { _ in
      symbol.draw(at: .zero)
    }
    return bitmap.withRenderingMode(.alwaysTemplate)
  }
}

/// The tab bar of the `bar` form: a public `UITabBar` that the shell places
/// itself, so its capsule sits at the bottom-leading edge. A `UITabBar` draws
/// its glass capsule at the top of its bounds, centered, with `margin` on each
/// side, and sizes its items to the capsule.
@MainActor
final class StandaloneTabBar: NSObject, UITabBarDelegate {
  static let capsuleHeight: CGFloat = 62
  static let capsuleWidth: CGFloat = 230
  private static let margin: CGFloat = 21
  private static let barHeight: CGFloat = 83

  let bar = UITabBar()
  private let onSelect: (ChromeTab) -> Void

  init(onSelect: @escaping (ChromeTab) -> Void) {
    self.onSelect = onSelect
    super.init()
    bar.items = ChromeTab.allCases.enumerated().map { index, tab in
      UITabBarItem(title: tab.title, image: tab.image, tag: index)
    }
    bar.delegate = self
  }

  func select(_ tab: ChromeTab) {
    bar.selectedItem = bar.items?.first { $0.tag == ChromeTab.allCases.firstIndex(of: tab) }
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    onSelect(ChromeTab.allCases[item.tag])
  }

  /// Places the bar so its capsule starts at `leading` and its bottom edge is
  /// at the bottom of `bounds`. Returns the capsule's frame.
  @discardableResult
  func layout(in bounds: CGRect, leading: CGFloat) -> CGRect {
    bar.frame = CGRect(
      x: leading - Self.margin, y: bounds.maxY - Self.barHeight,
      width: Self.capsuleWidth + Self.margin * 2, height: Self.barHeight)
    return CGRect(
      x: leading, y: bar.frame.minY, width: Self.capsuleWidth, height: Self.capsuleHeight)
  }
}
