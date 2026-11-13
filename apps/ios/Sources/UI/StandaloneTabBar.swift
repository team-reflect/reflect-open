import ChromeKit
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

  /// Places the bar at the bottom of `view` with its first item at
  /// `leading`. Returns the frame of its items in `view`.
  func layout(in view: UIView, leading: CGFloat) -> CGRect {
    let bounds = view.bounds
    let height = bar.sizeThatFits(bounds.size).height
    bar.frame = CGRect(x: 0, y: bounds.maxY - height, width: bounds.width, height: height)
    bar.layoutIfNeeded()
    let items = (bar.items ?? []).compactMap { $0.frame(in: view) }.reduce(CGRect.null) {
      $0.union($1)
    }
    guard !items.isNull else { return bar.frame }
    bar.frame.origin.x += leading - items.minX
    return items.offsetBy(dx: leading - items.minX, dy: 0)
  }
}
