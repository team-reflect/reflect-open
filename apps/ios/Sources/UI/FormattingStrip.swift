import ChromeKit
import UIKit

/// The formatting toolbar above the keyboard: the format buttons scroll
/// sideways, and the button that hides the keyboard stays at the trailing
/// edge. Its buttons never take focus, so the caret stays in the editor.
@MainActor
final class FormattingStrip: UIInputView {
  private struct Item {
    /// The command of the button, or `nil` for Insert image.
    let command: FormattingCommand?
    let icon: String
    let label: String

    var id: String { command?.rawValue ?? "image" }
  }

  private static let items: [Item] = [
    Item(command: .slash, icon: "slash.circle", label: "Slash command"),
    Item(command: .list, icon: "list.bullet", label: "Cycle list style"),
    Item(command: .todo, icon: "checklist", label: "Cycle checklist and task"),
    Item(command: .link, icon: "link", label: "Link note"),
    Item(command: .tag, icon: "number", label: "Tag"),
    Item(command: .dedent, icon: "decrease.indent", label: "Outdent"),
    Item(command: .indent, icon: "increase.indent", label: "Indent"),
    Item(command: .up, icon: "arrow.up", label: "Move up"),
    Item(command: .down, icon: "arrow.down", label: "Move down"),
    Item(command: nil, icon: "photo", label: "Insert image"),
  ]

  /// Runs a command of the page's formatting toolbar.
  var onCommand: (FormattingCommand) -> Void = { _ in }
  /// The user tapped Insert image.
  var onInsertImage: () -> Void = {}

  private var buttons: [String: UIButton] = [:]
  private let scroll = UIScrollView()
  private let dismiss = UIButton(type: .system)
  private lazy var leading = scroll.leadingAnchor.constraint(equalTo: leadingAnchor)
  private lazy var trailing = dismiss.trailingAnchor.constraint(equalTo: trailingAnchor)

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 400, height: 48), inputViewStyle: .keyboard)
    allowsSelfSizing = true
    // A `UIInputView` draws no background on iOS 26 and later.
    let background = UIVisualEffectView()
    if #available(iOS 26, *) {
      background.effect = UIGlassEffect()
    } else {
      background.effect = UIBlurEffect(style: .systemChromeMaterial)
    }
    background.frame = bounds
    background.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(background)
    // The symbols follow Dynamic Type up to a size that fits the 48 pt strip.
    maximumContentSizeCategory = .accessibilityMedium
    let symbols = UIImage.SymbolConfiguration(textStyle: .body)
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 4
    for item in Self.items {
      let button = UIButton(type: .system)
      button.setImage(UIImage(systemName: item.icon), for: .normal)
      button.setPreferredSymbolConfiguration(symbols, forImageIn: .normal)
      button.accessibilityLabel = item.label
      button.addAction(
        UIAction { [weak self] _ in self?.tap(item.command) }, for: .primaryActionTriggered)
      button.widthAnchor.constraint(equalToConstant: 40).isActive = true
      buttons[item.id] = button
      row.addArrangedSubview(button)
    }
    scroll.showsHorizontalScrollIndicator = false
    scroll.addSubview(row)
    dismiss.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
    dismiss.setPreferredSymbolConfiguration(symbols, forImageIn: .normal)
    dismiss.accessibilityLabel = "Hide keyboard"
    dismiss.addAction(
      UIAction { [weak self] _ in self?.tap(.dismiss) }, for: .primaryActionTriggered)
    let divider = UIView()
    divider.backgroundColor = .separator
    for view in [scroll, divider, dismiss] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    row.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 48),
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.trailingAnchor.constraint(equalTo: divider.leadingAnchor, constant: -4),
      divider.widthAnchor.constraint(equalToConstant: 1),
      divider.heightAnchor.constraint(equalToConstant: 24),
      divider.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -4),
      dismiss.widthAnchor.constraint(equalToConstant: 44),
      dismiss.topAnchor.constraint(equalTo: topAnchor),
      dismiss.bottomAnchor.constraint(equalTo: bottomAnchor),
      row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
    ])
    NSLayoutConstraint.activate([leading, trailing])
    tintColor = .label
  }

  override func layoutSubviews() {
    let insets = horizontalInsets()
    leading.constant = insets.left + 8
    trailing.constant = -insets.right - 8
    super.layoutSubviews()
  }

  /// The safe area where a camera or a sensor reaches the strip's row, as it
  /// does the keyboard's. On an iPhone Duo the camera column ends above the
  /// keyboard, so the strip spans the full width like the keys below it.
  private func horizontalInsets() -> UIEdgeInsets {
    if #available(iOS 27.1, *) {
      let occluded = reservedRegions(kind: .occlusion).contains { $0.frame.intersects(bounds) }
      return occluded ? safeAreaInsets : .zero
    }
    return safeAreaInsets
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// Enables the buttons that the focused editor can run.
  func update(_ toolbar: ToolbarState) {
    buttons[FormattingCommand.indent.rawValue]?.isEnabled = toolbar.canIndent
    buttons[FormattingCommand.dedent.rawValue]?.isEnabled = toolbar.canDedent
    buttons[FormattingCommand.up.rawValue]?.isEnabled = toolbar.canMoveUp
    buttons[FormattingCommand.down.rawValue]?.isEnabled = toolbar.canMoveDown
    buttons["image"]?.isHidden = !toolbar.canAttachFiles
  }

  /// A tap on the button of `command`, or on Insert image for `nil`.
  private func tap(_ command: FormattingCommand?) {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    if let command {
      onCommand(command)
    } else {
      onInsertImage()
    }
  }
}
