import ChromeKit
import UIKit

/// The formatting toolbar above the keyboard: the format buttons scroll
/// sideways, and the button that hides the keyboard stays at the trailing
/// edge. Its buttons never take focus, so the caret stays in the editor.
@MainActor
final class FormattingStrip: UIInputView {
  private struct Item {
    let id: String
    let icon: String
    let label: String
  }

  private static let items: [Item] = [
    Item(id: "slash", icon: "slash.circle", label: "Slash command"),
    Item(id: "list", icon: "list.bullet", label: "Cycle list style"),
    Item(id: "todo", icon: "checklist", label: "Cycle checklist and task"),
    Item(id: "link", icon: "link", label: "Link note"),
    Item(id: "tag", icon: "number", label: "Tag"),
    Item(id: "dedent", icon: "decrease.indent", label: "Outdent"),
    Item(id: "indent", icon: "increase.indent", label: "Indent"),
    Item(id: "up", icon: "arrow.up", label: "Move up"),
    Item(id: "down", icon: "arrow.down", label: "Move down"),
    Item(id: "image", icon: "photo", label: "Insert image"),
  ]

  /// Runs the format command with an id of the web toolbar.
  var onCommand: (String) -> Void = { _ in }
  /// The user tapped Insert image.
  var onInsertImage: () -> Void = {}

  private var buttons: [String: UIButton] = [:]

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 400, height: 48), inputViewStyle: .keyboard)
    allowsSelfSizing = true
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
        UIAction { [weak self] _ in self?.tap(item.id) }, for: .primaryActionTriggered)
      button.widthAnchor.constraint(equalToConstant: 40).isActive = true
      buttons[item.id] = button
      row.addArrangedSubview(button)
    }
    let scroll = UIScrollView()
    scroll.showsHorizontalScrollIndicator = false
    scroll.addSubview(row)
    let dismiss = UIButton(type: .system)
    dismiss.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
    dismiss.setPreferredSymbolConfiguration(symbols, forImageIn: .normal)
    dismiss.accessibilityLabel = "Hide keyboard"
    dismiss.addAction(
      UIAction { [weak self] _ in self?.tap("dismiss") }, for: .primaryActionTriggered)
    let divider = UIView()
    divider.backgroundColor = .separator
    for view in [scroll, divider, dismiss] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    row.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 48),
      scroll.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 8),
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.trailingAnchor.constraint(equalTo: divider.leadingAnchor, constant: -4),
      divider.widthAnchor.constraint(equalToConstant: 1),
      divider.heightAnchor.constraint(equalToConstant: 24),
      divider.centerYAnchor.constraint(equalTo: centerYAnchor),
      divider.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -4),
      dismiss.trailingAnchor.constraint(
        equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -8),
      dismiss.widthAnchor.constraint(equalToConstant: 44),
      dismiss.topAnchor.constraint(equalTo: topAnchor),
      dismiss.bottomAnchor.constraint(equalTo: bottomAnchor),
      row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
    ])
    tintColor = .label
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// Enables the buttons that the focused editor can run.
  func update(_ toolbar: ToolbarState) {
    buttons["indent"]?.isEnabled = toolbar.canIndent
    buttons["dedent"]?.isEnabled = toolbar.canDedent
    buttons["up"]?.isEnabled = toolbar.canMoveUp
    buttons["down"]?.isEnabled = toolbar.canMoveDown
    buttons["image"]?.isHidden = !toolbar.canAttachFiles
  }

  private func tap(_ id: String) {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    if id == "image" {
      onInsertImage()
    } else {
      onCommand(id)
    }
  }
}
