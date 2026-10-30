import Tauri
import UIKit
import WebKit

// Mirror the serde models in `src/models.rs` and the TS types in
// `packages/core/src/ipc/native-menu-plugin.ts`.
struct KeyEquivalentArgs: Decodable {
  let input: String
  let modifiers: [String]
}

struct MenuItemArgs: Decodable {
  let kind: String
  let id: String?
  let title: String?
  let keyEquivalent: KeyEquivalentArgs?
}

struct MenuSectionArgs: Decodable {
  let title: String
  let placement: String?
  let items: [MenuItemArgs]
}

struct SetMenuArgs: Decodable {
  let sections: [MenuSectionArgs]
}

struct ContextMenuItemArgs: Decodable {
  let id: String
  let title: String
  let destructive: Bool?
}

struct ContextMenuArgs: Decodable {
  let items: [ContextMenuItemArgs]
  let x: Double
  let y: Double
}

struct MenuCommandPayload: Encodable {
  let id: String
}

struct ContextMenuChoice: Encodable {
  let id: String?
}

/// Reflect's native iPadOS menus: the menu bar (`UIMainMenuSystem`, iPadOS
/// 26+) and context menus at a point in the webview.
///
/// The webview sends the menu bar the same command layout the macOS app menu
/// is built from; this plugin files each section into its standard menu (the
/// app menu, File, Edit, View, Window, Help) and reports activations back as
/// `menuCommand`. Key equivalents live here too. On iPadOS a main-menu key
/// command claims its keystroke before the webview sees it, so every shortcut
/// on the menu runs through the same dispatch as a menu click, and system
/// element groups whose shortcuts would shadow Reflect's (text formatting's
/// ⌘B/⌘I/⌘U, Find, the Settings app link) are removed.
class NativeMenuPlugin: Plugin {
  /// The responder-chain action reaches the plugin through this reference:
  /// UIKit hands menu commands to `UIApplication`, not to the plugin.
  fileprivate static weak var shared: NativeMenuPlugin?

  private weak var webview: WKWebView?
  private var sections: [MenuSectionArgs] = []
  /// A 1-point view at the menu's point, carrying the `UIEditMenuInteraction`
  /// (iOS 16+) the menu presents through, for as long as the menu is up. The
  /// interaction never sits on the webview itself: there it would answer the
  /// clicks and long-presses meant for the page with menus of its own.
  private var contextMenuAnchor: UIView?
  fileprivate var pendingContextMenu: (items: [ContextMenuItemArgs], invoke: Invoke)?

  override init() {
    super.init()
    NativeMenuPlugin.shared = self
  }

  @objc public override func load(webview: WKWebView) {
    self.webview = webview
  }

  @objc public func setMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetMenuArgs.self)
    DispatchQueue.main.async {
      self.sections = args.sections
      self.installMenuBar()
      invoke.resolve()
    }
  }

  /// Present a context menu at a point of the webview (CSS pixels are points:
  /// the page never zooms or scrolls natively) and resolve with the chosen
  /// item's id, or `null` when it was dismissed. A trackpad's secondary click
  /// gets iPadOS's context-menu presentation, a touch the edit-menu callout.
  @objc public func presentContextMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ContextMenuArgs.self)
    DispatchQueue.main.async {
      guard #available(iOS 16.0, *), let webview = self.webview else {
        invoke.resolve(ContextMenuChoice(id: nil))
        return
      }
      // A menu still up (the user right-clicked again) settles as dismissed.
      self.finishContextMenu(choosing: nil)
      self.removeContextMenuAnchor()
      let anchor = UIView(frame: CGRect(x: args.x, y: args.y, width: 1, height: 1))
      let interaction = UIEditMenuInteraction(delegate: self)
      anchor.addInteraction(interaction)
      webview.addSubview(anchor)
      self.contextMenuAnchor = anchor
      self.pendingContextMenu = (args.items, invoke)
      interaction.presentEditMenu(
        with: UIEditMenuConfiguration(identifier: nil, sourcePoint: .zero))
    }
  }

  fileprivate func finishContextMenu(choosing id: String?) {
    guard let pending = pendingContextMenu else { return }
    pendingContextMenu = nil
    pending.invoke.resolve(ContextMenuChoice(id: id))
  }

  fileprivate func removeContextMenuAnchor() {
    contextMenuAnchor?.removeFromSuperview()
    contextMenuAnchor = nil
  }

  fileprivate func perform(commandId: String) {
    do {
      try trigger("menuCommand", data: MenuCommandPayload(id: commandId))
    } catch {
      Logger.error("[native-menu] failed to deliver \(commandId): \(error)")
    }
  }

  private func installMenuBar() {
    // Before iPadOS 26 there is no menu bar to fill; every shortcut still
    // reaches the webview's own keydown handling.
    guard #available(iOS 26.0, *) else { return }
    let configuration = UIMainMenuSystem.Configuration()
    // Windows arrive with multi-window support; until then a "New Window"
    // item would open a second copy that cannot share the graph session.
    configuration.newScenePreference = .removed
    configuration.documentPreference = .removed
    configuration.printingPreference = .removed
    // Find, Find Next and Find Previous are Reflect commands (⌘F, ⌘G, ⇧⌘G).
    configuration.findingPreference = .removed
    configuration.toolbarPreference = .removed
    // The sidebar toggle is Reflect's own (⌘\).
    configuration.sidebarPreference = .removed
    configuration.inspectorPreference = .removed
    // WebKit would answer ⌘B/⌘I/⌘U with HTML formatting the markdown editor
    // cannot read; the editor's own keymap handles them instead.
    configuration.textFormattingPreference = .removed
    UIMainMenuSystem.shared.setBuildConfiguration(configuration) { [weak self] builder in
      self?.build(into: builder)
    }
  }

  @available(iOS 26.0, *)
  private func build(into builder: UIMenuBuilder) {
    for (sectionIndex, section) in sections.enumerated() {
      let groups = Self.groups(of: section, at: sectionIndex)
      guard !groups.isEmpty else { continue }
      switch section.placement {
      case "application":
        // The system's Settings item opens the Settings app; Reflect's own
        // settings take its place.
        builder.remove(menu: .preferences)
        for group in groups.reversed() {
          builder.insertSibling(group, afterMenu: .about)
        }
      case "file":
        groups.forEach { builder.insertChild($0, atEndOfMenu: .file) }
      case "edit":
        groups.forEach { builder.insertChild($0, atEndOfMenu: .edit) }
      case "view":
        for group in groups.reversed() {
          builder.insertChild(group, atStartOfMenu: .view)
        }
      case "window":
        for group in groups.reversed() {
          builder.insertChild(group, atStartOfMenu: .window)
        }
      case "help":
        groups.forEach { builder.insertChild($0, atEndOfMenu: .help) }
      default:
        let menu = UIMenu(
          title: section.title,
          identifier: UIMenu.Identifier("app.reflect.menu.\(sectionIndex)"),
          children: groups)
        builder.insertSibling(menu, beforeMenu: .window)
      }
    }
  }

  /// Each run of items between separators becomes one inline group, drawn
  /// with a divider on either side like the macOS menu's separators.
  private static func groups(of section: MenuSectionArgs, at sectionIndex: Int) -> [UIMenu] {
    var groups: [[UIMenuElement]] = [[]]
    for item in section.items {
      if item.kind == "separator" {
        groups.append([])
      } else if let element = element(for: item) {
        groups[groups.count - 1].append(element)
      }
    }
    return groups.enumerated().compactMap { groupIndex, children in
      guard !children.isEmpty else { return nil }
      return UIMenu(
        title: "",
        identifier: UIMenu.Identifier("app.reflect.menu.\(sectionIndex).\(groupIndex)"),
        options: .displayInline,
        children: children)
    }
  }

  private static func element(for item: MenuItemArgs) -> UIMenuElement? {
    guard let id = item.id, let title = item.title else { return nil }
    let action = #selector(UIApplication.reflectPerformMainMenuCommand(_:))
    guard let key = item.keyEquivalent, let input = keyInput(key.input) else {
      return UICommand(title: title, action: action, propertyList: id)
    }
    return UIKeyCommand(
      title: title,
      action: action,
      input: input,
      modifierFlags: modifierFlags(key.modifiers),
      propertyList: id)
  }

  private static func keyInput(_ name: String) -> String? {
    switch name {
    case "enter": return "\r"
    case "escape": return UIKeyCommand.inputEscape
    case "tab": return "\t"
    case "delete": return UIKeyCommand.inputDelete
    case "upArrow": return UIKeyCommand.inputUpArrow
    case "downArrow": return UIKeyCommand.inputDownArrow
    case "leftArrow": return UIKeyCommand.inputLeftArrow
    case "rightArrow": return UIKeyCommand.inputRightArrow
    default: return name.count == 1 ? name : nil
    }
  }

  private static func modifierFlags(_ names: [String]) -> UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    for name in names {
      switch name {
      case "command": flags.insert(.command)
      case "shift": flags.insert(.shift)
      case "alternate": flags.insert(.alternate)
      case "control": flags.insert(.control)
      default: break
      }
    }
    return flags
  }
}

@available(iOS 16.0, *)
extension NativeMenuPlugin: UIEditMenuInteractionDelegate {
  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let pending = pendingContextMenu else { return nil }
    return UIMenu(
      children: pending.items.map { item in
        UIAction(
          title: item.title,
          attributes: item.destructive == true ? .destructive : []
        ) { [weak self] _ in
          self?.finishContextMenu(choosing: item.id)
        }
      })
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    willDismissMenuFor configuration: UIEditMenuConfiguration,
    animator: UIEditMenuInteractionAnimating
  ) {
    // A chosen action settles first; this only catches a dismissal. The
    // anchor goes once the menu is gone. A menu replaced by a newer one
    // (`presentContextMenu` already settled it) leaves the newer request and
    // anchor alone.
    animator.addCompletion { [weak self] in
      guard let self, self.contextMenuAnchor === interaction.view else { return }
      self.finishContextMenu(choosing: nil)
      self.removeContextMenuAnchor()
    }
  }
}

extension UIApplication {
  /// The target of every Reflect menu command. `UIApplication` sits at the
  /// end of every window's responder chain, so the commands resolve whether
  /// the editor, another element or nothing has focus.
  @objc func reflectPerformMainMenuCommand(_ sender: UICommand) {
    guard let id = sender.propertyList as? String else { return }
    NativeMenuPlugin.shared?.perform(commandId: id)
  }
}

@_cdecl("init_plugin_native_menu")
public func initPlugin() -> Plugin {
  return NativeMenuPlugin()
}
