import ChromeKit
import TypesShared
import UIKit

/// The tab bar of the `bar` form: a public `UITabBar` that the shell places
/// itself, so its capsule sits at the bottom-leading edge. A `UITabBar` draws
/// its glass capsule centered in its bounds.
@MainActor
final class StandaloneTabBar: NSObject, UITabBarDelegate {
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

  /// How far the system's glass capsule reaches past the items on every side.
  static let capsuleInset: CGFloat = 4

  /// How far the bar reaches past its capsule on each side. A bar narrower
  /// than the capsule's natural width plus these margins squeezes the capsule.
  private static let barMargin: CGFloat = 10

  /// Places the bar at the bottom of `view` with its capsule at most `maxWidth`
  /// wide, as far from the leading safe area edge as the system puts it from
  /// the bottom edge. Returns the frame of the capsule in `view`.
  func layout(in view: UIView, maxWidth: CGFloat) -> CGRect {
    let bounds = view.bounds
    let height = bar.sizeThatFits(bounds.size).height
    let width = min(bounds.width, maxWidth + 2 * Self.barMargin)
    bar.frame = CGRect(x: 0, y: bounds.maxY - height, width: width, height: height)
    bar.layoutIfNeeded()
    let items = (bar.items ?? []).compactMap { $0.frame(in: view) }.reduce(CGRect.null) {
      $0.union($1)
    }
    guard !items.isNull else { return bar.frame }
    let capsule = items.insetBy(dx: -Self.capsuleInset, dy: -Self.capsuleInset)
    let leading = view.safeAreaInsets.left + bounds.maxY - capsule.maxY
    bar.frame.origin.x += leading - capsule.minX
    return capsule.offsetBy(dx: leading - capsule.minX, dy: 0)
  }
}
