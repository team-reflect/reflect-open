import ChromeKit
import TypesShared
import UIKit
import WebKit

/// One page of the native chrome. It holds the web view while its tab is
/// selected, edge to edge, so the system bars float over the page and reach
/// the web layout through the safe area. Native corner buttons float over
/// the top row of the page; the page draws the rest of that row.
@MainActor
final class WebPageController: UIViewController {
  /// The tab of this page.
  let chromeTab: ChromeTab

  /// Holds the corner buttons over the web view. Touches between the
  /// buttons reach the web view.
  let cornerButtons = PassthroughView()
  /// The back button and the `leading` buttons, in the top-left corner.
  private let leadingGroup = UIStackView()
  /// The `trailing` buttons, in the top-right corner.
  private let trailingGroup = UIStackView()
  private var rowCenters: [NSLayoutConstraint] = []
  private lazy var leadingEdge = leadingGroup.leadingAnchor.constraint(
    equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Self.margin)

  /// The center of the row of the corner buttons, from the top of the view.
  /// `nil` centers them on the page's header row, right under the top safe
  /// area.
  var topRowCenter: CGFloat? {
    didSet { updateRowCenter() }
  }

  /// The buttons on screen, so a state with the same buttons keeps them,
  /// and an open menu stays open.
  private var shownLeading: [BarButton]?
  private var shownTrailing: [BarButton]?
  private var shownBack = BackButtons.none
  /// The history entry the buttons send their intents for.
  private var shownEntryId: Int?

  /// The height of the page's header row and of each corner button.
  private static let rowHeight: CGFloat = 48
  static let buttonSize: CGFloat = 44
  /// The space between a corner group and the edge of the safe area.
  private static let margin: CGFloat = 8

  init(tab: ChromeTab) {
    self.chromeTab = tab
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func loadView() {
    let view = UIView()
    view.backgroundColor = .systemBackground
    self.view = view
    cornerButtons.translatesAutoresizingMaskIntoConstraints = false
    cornerButtons.isHidden = true
    view.addSubview(cornerButtons)
    for group in [leadingGroup, trailingGroup] {
      group.axis = .horizontal
      group.spacing = 8
      group.alignment = .center
      group.translatesAutoresizingMaskIntoConstraints = false
      cornerButtons.addSubview(group)
    }
    let safe = view.safeAreaLayoutGuide
    rowCenters = [
      leadingGroup.centerYAnchor.constraint(equalTo: view.topAnchor),
      trailingGroup.centerYAnchor.constraint(equalTo: view.topAnchor),
    ]
    NSLayoutConstraint.activate(
      rowCenters + [
        cornerButtons.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        cornerButtons.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        cornerButtons.topAnchor.constraint(equalTo: view.topAnchor),
        cornerButtons.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        leadingEdge,
        trailingGroup.trailingAnchor.constraint(
          equalTo: safe.trailingAnchor, constant: -Self.margin),
        leadingGroup.trailingAnchor.constraint(
          lessThanOrEqualTo: trailingGroup.leadingAnchor, constant: -Self.margin),
      ])
    updateRowCenter()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let constant = Self.margin + windowControlsWidth
    if leadingEdge.constant != constant {
      leadingEdge.constant = constant
    }
  }

  /// How far a window's controls reach past the leading safe area, in the
  /// row of the floating tab bar. The page's own safe area starts under that
  /// row, so it leaves the controls out.
  private var windowControlsWidth: CGFloat {
    guard #available(iOS 26, *), topRowCenter != nil, let window = view.window else { return 0 }
    let controls = window.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal)).left
    let start = view.convert(CGPoint.zero, to: window).x + view.safeAreaInsets.left
    return max(0, controls - start)
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    updateRowCenter()
  }

  private func updateRowCenter() {
    guard isViewLoaded else { return }
    let center = topRowCenter ?? view.safeAreaInsets.top + Self.rowHeight / 2
    for constraint in rowCenters where constraint.constant != center {
      constraint.constant = center
    }
    // The leading edge follows the row: see `windowControlsWidth`.
    view.setNeedsLayout()
  }

  /// Whether the web view is in this page.
  func holds(_ webView: WKWebView) -> Bool {
    webView.superview === view
  }

  /// Moves the web view into this page, under every other subview. A web
  /// view that had the focus gets it back, as leaving the window resigns it.
  func attach(_ webView: WKWebView) {
    guard !holds(webView) else { return }
    let focused = Self.holdsFirstResponder(webView)
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.insertSubview(webView, at: 0)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    if focused {
      _ = webView.becomeFirstResponder()
    }
  }

  private static func holdsFirstResponder(_ view: UIView) -> Bool {
    view.isFirstResponder || view.subviews.contains { holdsFirstResponder($0) }
  }

  /// Shows the corner buttons of `state`. Buttons send `action` intents,
  /// menus come from `menus`, and the back button sends `back`. With
  /// `animated`, the buttons that change morph when the buttons were on
  /// screen.
  func showBar(
    _ state: ChromeState, animated: Bool, menus: MenuPresenter,
    send: @escaping (ChromeIntent) -> Void
  ) {
    let wasShown = shownEntryId != nil && !cornerButtons.isHidden
    cornerButtons.isHidden = Self.hidesBar(state)
    let back = BackButtons(state)
    let fades = animated && wasShown
    let entryId = state.entryId
    let newEntry = entryId != shownEntryId
    shownEntryId = entryId

    if newEntry || state.leading != shownLeading || back != shownBack {
      let shown = Self.shownButtons(in: leadingGroup).dropFirst(back.count)
      if !newEntry, back == shownBack, let shownLeading,
        Self.differInMenusOnly(state.leading, shownLeading), shown.count == state.leading.count
      {
        setMenus(of: Array(shown), to: state.leading, entryId: entryId, menus: menus)
      } else {
        var items: [CornerItem] = []
        switch back {
        case .none:
          break
        case .back:
          items.append(.arrow(forward: false) { send(.back(.init(entryId: entryId))) })
        case .history(let history):
          var backItem = CornerItem.arrow(forward: false) {
            send(.history(.init(entryId: entryId, direction: .back)))
          }
          backItem.isEnabled = history.back
          var forwardItem = CornerItem.arrow(forward: true) {
            send(.history(.init(entryId: entryId, direction: .forward)))
          }
          forwardItem.isEnabled = history.forward
          items += [backItem, forwardItem]
        }
        items += state.leading.map { cornerItem($0, entryId: entryId, menus: menus, send: send) }
        setItems(items, in: leadingGroup, animated: fades)
      }
      shownLeading = state.leading
      shownBack = back
    }

    if newEntry || state.trailing != shownTrailing {
      let shown = Self.shownButtons(in: trailingGroup)
      if !newEntry, let shownTrailing, Self.differInMenusOnly(state.trailing, shownTrailing),
        shown.count == state.trailing.count
      {
        setMenus(of: shown, to: state.trailing, entryId: entryId, menus: menus)
      } else {
        let items = state.trailing.map {
          cornerItem($0, entryId: entryId, menus: menus, send: send)
        }
        setItems(items, in: trailingGroup, animated: fades)
      }
      shownTrailing = state.trailing
    }
  }

  /// The buttons of `group`, without the ones that animate away.
  private static func shownButtons(in group: UIStackView) -> [CornerButton] {
    group.arrangedSubviews.compactMap { $0 as? CornerButton }.filter { !$0.isLeaving }
  }

  /// Puts buttons for `items` in `group`. With `animated`, the buttons morph
  /// as system bar buttons do. The button at each place stays: it replaces
  /// its symbol, and its glass resizes when a title becomes an icon. A new
  /// button grows out of nothing, and a removed button shrinks away.
  private func setItems(_ items: [CornerItem], in group: UIStackView, animated: Bool) {
    let shown = Self.shownButtons(in: group)
    guard animated, #available(iOS 26, *) else {
      for view in group.arrangedSubviews {
        view.removeFromSuperview()
      }
      for item in items {
        group.addArrangedSubview(CornerButton(item))
      }
      return
    }
    let added = items.dropFirst(shown.count).map { item in
      let button = CornerButton(item)
      button.alpha = 0
      group.addArrangedSubview(button)
      return button
    }
    // A hidden button has no frame of its own, so it would grow from the
    // corner of the group. Start it at the frame it ends at.
    UIView.performWithoutAnimation {
      cornerButtons.layoutIfNeeded()
      let frames = added.map(\.frame)
      for button in added {
        button.isHidden = true
      }
      cornerButtons.layoutIfNeeded()
      for (button, frame) in zip(added, frames) {
        button.frame = frame
        button.transform = CornerButton.small
      }
    }
    for (button, item) in zip(shown, items) {
      button.show(item)
    }
    let leaving = shown.dropFirst(items.count)
    for button in leaving {
      button.isLeaving = true
    }
    UIView.animate(springDuration: 0.4, bounce: 0.2) {
      for button in leaving {
        button.isHidden = true
        button.alpha = 0
        button.transform = CornerButton.small
      }
      for button in added {
        button.isHidden = false
        button.alpha = 1
        button.transform = .identity
      }
      self.cornerButtons.layoutIfNeeded()
    } completion: { _ in
      for button in leaving {
        button.removeFromSuperview()
      }
    }
  }

  /// Only menus changed: the same buttons take the new menus, so an open
  /// menu stays open and a confirmation keeps its anchor.
  private func setMenus(
    of views: [UIView], to buttons: [BarButton], entryId: Int, menus: MenuPresenter
  ) {
    for (view, button) in zip(views, buttons) {
      guard let control = view as? UIButton, let items = button.menu else { continue }
      let menu = menus.barMenu(items, entryId: entryId) { [weak control] in control }
      control.menu = menu
      control.contextMenuInteraction?.updateVisibleMenu { _ in menu }
    }
  }

  /// Whether `a` and `b` show the same buttons and differ only in the
  /// items of their menus.
  private static func differInMenusOnly(_ a: [BarButton], _ b: [BarButton]) -> Bool {
    a.count == b.count
      && zip(a, b).allSatisfy { next, shown in
        next.id == shown.id && next.title == shown.title && next.icon == shown.icon
          && (next.menu == nil) == (shown.menu == nil)
      }
  }

  /// Whether `state` hides the corner buttons.
  static func hidesBar(_ state: ChromeState) -> Bool {
    state.chrome == .none
  }

  /// Hides the corner buttons and forgets them, so nothing of an old
  /// document stays on screen.
  func clearBar() {
    cornerButtons.isHidden = true
    setItems([], in: leadingGroup, animated: false)
    setItems([], in: trailingGroup, animated: false)
    shownLeading = nil
    shownTrailing = nil
    shownBack = .none
    shownEntryId = nil
    setBarDimmed(false)
    setBarFaded(false, animated: false)
  }

  /// Fades the corner buttons out or back in, as a back swipe drags the
  /// page away or lets it settle back.
  func setBarFaded(_ faded: Bool, animated: Bool) {
    let alpha: CGFloat = faded ? 0 : 1
    guard animated else {
      cornerButtons.layer.removeAnimation(forKey: "opacity")
      cornerButtons.alpha = alpha
      return
    }
    UIView.animate(withDuration: 0.15, delay: 0, options: .beginFromCurrentState) {
      self.cornerButtons.alpha = alpha
    }
  }

  /// Dims the corner buttons and ignores their touches while a web drawer
  /// is open, as the system bars do behind a sheet.
  func setBarDimmed(_ dimmed: Bool) {
    cornerButtons.isUserInteractionEnabled = !dimmed
    // Only on a change: a set calls `tintColorDidChange` on every button,
    // which updates its configuration and cuts a symbol transition short.
    let mode: UIView.TintAdjustmentMode = dimmed ? .dimmed : .automatic
    if cornerButtons.tintAdjustmentMode != mode {
      cornerButtons.tintAdjustmentMode = mode
    }
  }

  private func cornerItem(
    _ button: BarButton, entryId: Int, menus: MenuPresenter,
    send: @escaping (ChromeIntent) -> Void
  ) -> CornerItem {
    let menu = button.menu.map { items in
      { (control: UIButton) in
        menus.barMenu(items, entryId: entryId) { [weak control] in control }
      }
    }
    return CornerItem(
      image: button.icon.flatMap { UIImage(systemName: $0) }, title: button.title,
      label: button.title, action: { send(.action(.init(entryId: entryId, id: button.id))) },
      menu: menu)
  }
}

/// A round glass button for an icon, or a glass capsule for a title.
@MainActor
private final class CornerButton: UIButton {
  /// The scale a button grows from and shrinks to.
  static let small = CGAffineTransform(scaleX: 0.5, y: 0.5)

  /// The button animates away; a new state does not reuse it.
  var isLeaving = false

  private lazy var iconWidth = widthAnchor.constraint(
    equalToConstant: WebPageController.buttonSize)
  private lazy var titleWidth = widthAnchor.constraint(
    greaterThanOrEqualToConstant: WebPageController.buttonSize)

  /// The identifier of the tap action, so a new action replaces the old one.
  private static let tapAction = UIAction.Identifier("corner-button-tap")

  init(_ item: CornerItem) {
    super.init(frame: .zero)
    var configuration: UIButton.Configuration
    if #available(iOS 26, *) {
      configuration = .glass()
      configuration.symbolContentTransition = UISymbolContentTransition(.replace.downUp)
    } else {
      configuration = .gray()
      configuration.cornerStyle = .capsule
    }
    // One line: a new button grows from zero width, and a wrapped title
    // keeps the narrow size.
    configuration.titleLineBreakMode = .byClipping
    self.configuration = configuration
    translatesAutoresizingMaskIntoConstraints = false
    heightAnchor.constraint(equalToConstant: WebPageController.buttonSize).isActive = true
    show(item)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// Shows `item`: its symbol or title, its label, and its tap action or
  /// menu.
  func show(_ item: CornerItem) {
    accessibilityLabel = item.label
    isEnabled = item.isEnabled
    removeAction(identifiedBy: Self.tapAction, for: .primaryActionTriggered)
    if let menu = item.menu {
      self.menu = menu(self)
      showsMenuAsPrimaryAction = true
    } else {
      self.menu = nil
      showsMenuAsPrimaryAction = false
      let action = item.action
      addAction(
        UIAction(identifier: Self.tapAction) { _ in action() }, for: .primaryActionTriggered)
    }
    var configuration = configuration
    configuration?.image = item.image
    configuration?.title = item.image == nil ? item.title : nil
    self.configuration = configuration
    iconWidth.isActive = item.image != nil
    titleWidth.isActive = item.image == nil
  }
}

/// What one corner button shows and does.
private struct CornerItem {
  let image: UIImage?
  let title: String?
  let label: String
  var isEnabled = true
  /// Runs on a tap when the button has no menu.
  let action: () -> Void
  /// Makes the menu of the button, anchored to the button it gets.
  let menu: ((UIButton) -> UIMenu)?

  /// A back or forward arrow that runs `action`.
  @MainActor
  static func arrow(forward: Bool, action: @escaping () -> Void) -> CornerItem {
    let name = forward ? "Forward" : "Back"
    return CornerItem(
      image: UIImage(systemName: forward ? "chevron.forward" : "chevron.backward"), title: nil,
      label: Bundle(for: UIButton.self).localizedString(forKey: name, value: name, table: nil),
      action: action, menu: nil)
  }
}

/// A view that takes touches only on its subviews, so the views under it
/// get every other touch.
final class PassthroughView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }
}

/// The arrows before the `leading` buttons: none, the back button of the
/// screen, or the back and forward buttons of the history.
private enum BackButtons: Equatable {
  case none
  case back
  case history(HistoryState)

  init(_ state: ChromeState) {
    if let history = state.history {
      self = .history(history)
    } else {
      self = state.canBack ? .back : .none
    }
  }

  /// The number of buttons.
  var count: Int {
    switch self {
    case .none: 0
    case .back: 1
    case .history: 2
    }
  }
}
