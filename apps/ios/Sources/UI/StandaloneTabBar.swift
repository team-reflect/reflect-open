import ChromeKit
import UIKit

/// The tab bar of the `bar` form: a public `UITabBar` that the shell places
/// itself, so its capsule sits at the bottom-leading edge. A `UITabBar` draws
/// its glass capsule at the top of its bounds, centered, with `margin` on each
/// side, and sizes its items to the capsule.
@MainActor
final class StandaloneTabBar: NSObject, UITabBarDelegate {
  private static let capsuleHeight: CGFloat = 62
  private static let capsuleWidth: CGFloat = 230
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
