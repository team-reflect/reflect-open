import ChromeKit
import TypesShared
import UIKit

/// The formatting toolbar above the keyboard: a capsule that holds the format
/// buttons, which scroll sideways, and the button that hides the keyboard at
/// its trailing end. The capsule is as wide as its buttons, centered, and no
/// wider than the strip. Its buttons never take focus, so the caret stays in
/// the editor.
@MainActor
final class FormattingStrip: UIView {
  private struct Item {
    /// The command of the button, or `nil` for Insert image.
    let command: FormattingCommand?
    let icon: String
    let label: String

    var id: String { command?.rawValue ?? "image" }
  }

  /// The sizes of the strip, in points.
  private enum Metrics {
    static let capsuleHeight: CGFloat = 44
    /// The space above and below the capsule.
    static let verticalMargin: CGFloat = 8
    /// The least space between the capsule and the strip's sides.
    static let horizontalMargin: CGFloat = 12
    /// The space between the capsule's ends and its buttons.
    static let contentInset: CGFloat = 8
    static let buttonWidth: CGFloat = 40
    static let buttonSpacing: CGFloat = 4
    static let dismissWidth: CGFloat = 44
    static let dividerWidth: CGFloat = 1
    static let dividerHeight: CGFloat = 24
    /// The space on each side of the divider.
    static let dividerSpacing: CGFloat = 4

    static let height = capsuleHeight + 2 * verticalMargin
    /// The width of the capsule beside the row of format buttons.
    static let fixedWidth =
      2 * contentInset + 2 * dividerSpacing + dividerWidth + dismissWidth
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
  private let capsule = UIVisualEffectView()
  private let scroll = UIScrollView()
  private let dismiss = UIButton(type: .system)
  /// The part of the strip that the capsule may fill.
  private let lane = UILayoutGuide()
  private lazy var leading = lane.leadingAnchor.constraint(equalTo: leadingAnchor)
  private lazy var trailing = lane.trailingAnchor.constraint(equalTo: trailingAnchor)

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 0, height: Metrics.height))
    // The keyboard sizes an accessory from its intrinsic height.
    autoresizingMask = .flexibleHeight
    if #available(iOS 26, *) {
      capsule.effect = UIGlassEffect()
      capsule.cornerConfiguration = .capsule()
    } else {
      capsule.effect = UIBlurEffect(style: .systemChromeMaterial)
      capsule.layer.cornerRadius = Metrics.capsuleHeight / 2
      capsule.layer.cornerCurve = .continuous
      capsule.clipsToBounds = true
    }
    // The symbols follow Dynamic Type up to a size that fits the capsule.
    maximumContentSizeCategory = .accessibilityMedium
    let symbols = UIImage.SymbolConfiguration(textStyle: .body)
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = Metrics.buttonSpacing
    for item in Self.items {
      let button = UIButton(type: .system)
      button.setImage(UIImage(systemName: item.icon), for: .normal)
      button.setPreferredSymbolConfiguration(symbols, forImageIn: .normal)
      button.accessibilityLabel = item.label
      button.addAction(
        UIAction { [weak self] _ in self?.tap(item.command) }, for: .primaryActionTriggered)
      button.widthAnchor.constraint(equalToConstant: Metrics.buttonWidth).isActive = true
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
    addLayoutGuide(lane)
    capsule.translatesAutoresizingMaskIntoConstraints = false
    addSubview(capsule)
    let content = capsule.contentView
    for view in [scroll, divider, dismiss] {
      view.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(view)
    }
    row.translatesAutoresizingMaskIntoConstraints = false
    // The capsule fills the lane until it holds every button.
    let fill = capsule.widthAnchor.constraint(equalTo: lane.widthAnchor)
    fill.priority = .defaultHigh
    NSLayoutConstraint.activate([
      leading,
      trailing,
      capsule.topAnchor.constraint(equalTo: topAnchor, constant: Metrics.verticalMargin),
      capsule.heightAnchor.constraint(equalToConstant: Metrics.capsuleHeight),
      capsule.centerXAnchor.constraint(equalTo: lane.centerXAnchor),
      capsule.leadingAnchor.constraint(greaterThanOrEqualTo: lane.leadingAnchor),
      capsule.trailingAnchor.constraint(lessThanOrEqualTo: lane.trailingAnchor),
      capsule.widthAnchor.constraint(
        lessThanOrEqualTo: row.widthAnchor, constant: Metrics.fixedWidth),
      fill,
      scroll.leadingAnchor.constraint(
        equalTo: content.leadingAnchor, constant: Metrics.contentInset),
      scroll.topAnchor.constraint(equalTo: content.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      scroll.trailingAnchor.constraint(
        equalTo: divider.leadingAnchor, constant: -Metrics.dividerSpacing),
      divider.widthAnchor.constraint(equalToConstant: Metrics.dividerWidth),
      divider.heightAnchor.constraint(equalToConstant: Metrics.dividerHeight),
      divider.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      divider.trailingAnchor.constraint(
        equalTo: dismiss.leadingAnchor, constant: -Metrics.dividerSpacing),
      dismiss.widthAnchor.constraint(equalToConstant: Metrics.dismissWidth),
      dismiss.topAnchor.constraint(equalTo: content.topAnchor),
      dismiss.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      dismiss.trailingAnchor.constraint(
        equalTo: content.trailingAnchor, constant: -Metrics.contentInset),
      row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
    ])
    tintColor = .label
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: Metrics.height)
  }

  override func layoutSubviews() {
    let insets = horizontalInsets()
    leading.constant = insets.left + Metrics.horizontalMargin
    trailing.constant = -insets.right - Metrics.horizontalMargin
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
