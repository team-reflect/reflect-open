import ChromeKit
import TypesShared
import UIKit

/// The `+` of the screen, over the page: one action, or Daily's capture menu,
/// whose items rise above the `+`.
@MainActor
final class PlusChrome {
  private static let itemSize: CGFloat = 48
  private static let itemGap: CGFloat = 12

  /// Sends a tap to the page.
  var send: (PlusCommand) -> Void = { _ in }

  private let button: UIButton
  /// Closes the menu on a tap outside it.
  private let scrim = UIControl()
  private let noteItem: UIButton
  private let taskItem: UIButton
  private let audioItem: UIButton
  private var spec: PlusState?
  private var hidden = true
  private var shown = false
  private var menuOpen = false

  init() {
    var config: UIButton.Configuration
    if #available(iOS 26, *) {
      config = .prominentGlass()
    } else {
      config = .filled()
    }
    config.image = UIImage(
      systemName: "plus",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
    config.cornerStyle = .capsule
    button = UIButton(configuration: config)
    noteItem = Self.makeItem("New note", symbol: "square.and.pencil")
    taskItem = Self.makeItem("New task", symbol: "checkmark.circle")
    audioItem = Self.makeItem("Record audio memo", symbol: "mic")
    button.addAction(UIAction { [weak self] _ in self?.tap() }, for: .primaryActionTriggered)
    scrim.addAction(UIAction { [weak self] _ in self?.setMenu(false) }, for: .touchUpInside)
    for (item, command) in [(noteItem, PlusCommand.note), (taskItem, .task), (audioItem, .audio)] {
      item.addAction(
        UIAction { [weak self] _ in
          self?.setMenu(false)
          self?.send(command)
        }, for: .primaryActionTriggered)
    }
    // The `+` stays purple when the iPad sidebar turns the tint gray.
    for view in [button, noteItem, taskItem, audioItem] {
      view.tintColor = ChromeTabController.accent
    }
    button.alpha = 0
    button.isHidden = true
  }

  private static func makeItem(_ label: String, symbol: String) -> UIButton {
    var config: UIButton.Configuration
    if #available(iOS 26, *) {
      config = .glass()
    } else {
      config = .tinted()
    }
    config.image = UIImage(systemName: symbol)
    config.cornerStyle = .capsule
    let item = UIButton(configuration: config)
    item.accessibilityLabel = label
    item.alpha = 0
    item.isHidden = true
    return item
  }

  private var items: [UIButton] {
    if case .capture(let capture) = spec, capture.audio != nil {
      return [noteItem, taskItem, audioItem]
    }
    return [noteItem, taskItem]
  }

  /// Shows `spec`, or no `+` for `nil`. The capture menu stays open while
  /// only its audio phase changes.
  func update(_ spec: PlusState?) {
    switch (self.spec, spec) {
    case (.capture, .capture):
      break
    default:
      setMenu(false)
    }
    self.spec = spec
    switch spec {
    case .action(let action):
      button.accessibilityLabel = action.label
    case .capture(let capture):
      button.accessibilityLabel = menuOpen ? "Hide capture actions" : "Show capture actions"
      updateAudioItem(capture.audio)
      if menuOpen {
        for item in items {
          item.isHidden = false
        }
        layoutItems()
      }
    case nil:
      break
    }
    updateShown()
  }

  /// Hides the `+` while `hidden`, as for a modal or the keyboard.
  func setHidden(_ hidden: Bool) {
    self.hidden = hidden
    updateShown()
  }

  private func updateShown() {
    let shown = !hidden && spec != nil
    if !shown {
      setMenu(false)
    }
    guard shown != self.shown else { return }
    self.shown = shown
    if shown {
      button.isHidden = false
    }
    UIView.animate(withDuration: 0.2) {
      self.button.alpha = shown ? 1 : 0
      self.button.transform = shown ? .identity : CGAffineTransform(scaleX: 0.8, y: 0.8)
    } completion: { _ in
      if !self.shown {
        self.button.isHidden = true
      }
    }
  }

  private func updateAudioItem(_ audio: AudioPhase?) {
    let recording = audio == .recording || audio == .requesting
    let (label, symbol) =
      switch audio {
      case .error: ("Show audio memo error", "exclamationmark.triangle")
      case .transcribing: ("Record audio memo", "waveform")
      case .recording, .requesting: ("Stop recording", "stop.fill")
      case .idle, nil: ("Record audio memo", "mic")
      }
    audioItem.accessibilityLabel = label
    audioItem.configuration?.image = UIImage(systemName: symbol)
    audioItem.configuration?.baseForegroundColor = recording || audio == .error ? .systemRed : nil
  }

  /// Puts the `+` of `size` at `center` in `view`, over the page.
  func layout(in view: UIView, center: CGPoint, size: CGFloat) {
    for subview in [scrim] + [noteItem, taskItem, audioItem] + [button]
    where subview.superview !== view {
      view.addSubview(subview)
    }
    for subview in [scrim] + [noteItem, taskItem, audioItem] + [button] {
      view.bringSubviewToFront(subview)
    }
    scrim.frame = view.bounds
    scrim.isHidden = !menuOpen
    button.bounds.size = CGSize(width: size, height: size)
    button.center = center
    layoutItems()
  }

  private func layoutItems() {
    let all = [noteItem, taskItem, audioItem]
    let shown = items
    for item in all {
      item.bounds.size = CGSize(width: Self.itemSize, height: Self.itemSize)
      let index = shown.firstIndex(of: item)
      let rise =
        button.bounds.height / 2 + Self.itemGap + Self.itemSize / 2
        + CGFloat(index ?? 0) * (Self.itemSize + Self.itemGap)
      let open = menuOpen && index != nil
      item.center = CGPoint(x: button.center.x, y: button.center.y - (open ? rise : 0))
      item.alpha = open ? 1 : 0
      item.transform = open ? .identity : CGAffineTransform(scaleX: 0.5, y: 0.5)
    }
  }

  private func tap() {
    switch spec {
    case .action:
      send(.tap)
    case .capture:
      setMenu(!menuOpen)
    case nil:
      break
    }
  }

  private func setMenu(_ open: Bool) {
    guard open != menuOpen else { return }
    menuOpen = open
    scrim.isHidden = !open
    if open {
      for item in items {
        item.isHidden = false
      }
    }
    if case .capture = spec {
      button.accessibilityLabel = open ? "Hide capture actions" : "Show capture actions"
    }
    UIView.animate(
      withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0
    ) {
      self.button.imageView?.transform =
        open ? CGAffineTransform(rotationAngle: .pi / 4) : .identity
      self.layoutItems()
    } completion: { _ in
      if !self.menuOpen {
        for item in [self.noteItem, self.taskItem, self.audioItem] {
          item.isHidden = true
        }
      }
    }
  }
}
