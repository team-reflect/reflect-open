public import Foundation

/// The chrome state that the page posts after every change.
public struct ChromeState: Decodable, Equatable, Sendable {
  /// Whether the page shows the routed shell or a surface outside it.
  public enum Chrome: String, Decodable, Sendable {
    case shell
    case none
  }

  /// The theme preference of the page.
  public enum Theme: String, Decodable, Sendable {
    case system
    case light
    case dark
  }

  /// Grows with every state of one document.
  public var generation: Int
  /// The history entry the state describes. Intents echo it.
  public var entryId: Int
  public var chrome: Chrome
  /// The kind of the route on screen, for logs.
  public var routeKind: String?
  public var tab: ChromeTab
  public var canBack: Bool
  /// The navigation bar title, or `nil` while the page does not know it.
  public var title: String?
  /// A menu on the title.
  public var titleMenu: [MenuItem]?
  /// Whether the page wants the native navigation bar.
  public var showsBar: Bool
  public var leading: [BarButton]
  public var trailing: [BarButton]
  public var keyboardVisible: Bool
  /// A web drawer is open.
  public var modal: Bool
  public var toolbar: ToolbarState?
  public var theme: Theme
}

/// A tab of the shell.
public enum ChromeTab: String, Codable, CaseIterable, Sendable {
  case daily
  case all
  case tasks
}

/// A confirmation before an item's intent: one destructive button and Cancel.
public struct MenuConfirm: Decodable, Equatable, Sendable {
  public var title: String
  public var message: String?
  /// The label of the destructive button.
  public var action: String
}

/// One row of a menu.
public struct MenuAction: Decodable, Equatable, Sendable {
  public var id: String
  public var title: String
  /// An SF Symbol name.
  public var icon: String?
  public var destructive: Bool
  public var disabled: Bool
  public var checked: Bool
  public var keepsMenuPresented: Bool
  public var confirm: MenuConfirm?

  private enum CodingKeys: String, CodingKey {
    case id, title, icon, destructive, disabled, checked, keepsMenuPresented, confirm
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    title = try container.decode(String.self, forKey: .title)
    icon = try container.decodeIfPresent(String.self, forKey: .icon)
    destructive = try container.decodeIfPresent(Bool.self, forKey: .destructive) ?? false
    disabled = try container.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
    checked = try container.decodeIfPresent(Bool.self, forKey: .checked) ?? false
    keepsMenuPresented =
      try container.decodeIfPresent(Bool.self, forKey: .keepsMenuPresented) ?? false
    confirm = try container.decodeIfPresent(MenuConfirm.self, forKey: .confirm)
  }
}

/// A row of a menu, or a section of rows.
public indirect enum MenuItem: Decodable, Equatable, Sendable {
  case action(MenuAction)
  case section(title: String?, items: [MenuItem])

  private enum CodingKeys: String, CodingKey {
    case type, title, items
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .type) {
    case "section":
      self = .section(
        title: try container.decodeIfPresent(String.self, forKey: .title),
        items: try container.decode([MenuItem].self, forKey: .items))
    default:
      self = .action(try MenuAction(from: decoder))
    }
  }
}

/// A button of the navigation bar. A tap opens `menu`, or sends an `action` intent.
public struct BarButton: Decodable, Equatable, Sendable {
  public var id: String
  public var title: String
  /// An SF Symbol name. Without it the button shows `title`.
  public var icon: String?
  public var menu: [MenuItem]?
}

/// The formatting toolbar of the focused editor.
public struct ToolbarState: Decodable, Equatable, Sendable {
  public var canIndent: Bool
  public var canDedent: Bool
  public var canMoveUp: Bool
  public var canMoveDown: Bool
  public var canAttachFiles: Bool
}

/// A rectangle in CSS pixels of the web view.
public struct ChromeRect: Decodable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
}

/// The page asks the shell to show a menu at a web element.
public struct MenuRequest: Decodable, Equatable, Sendable {
  public var entryId: Int
  public var menuId: String
  public var rect: ChromeRect
  public var items: [MenuItem]
}

/// A message from the page to the `reflectChrome` handler.
public enum ChromeMessage: Decodable, Equatable, Sendable {
  case state(ChromeState)
  case presentMenu(MenuRequest)
  /// A web push or pop slide starts (`true`) or ends (`false`).
  case transition(started: Bool)
  /// The page listens for intents.
  case chromeReady
  /// A new document of the main frame started.
  case documentStart

  private enum CodingKeys: String, CodingKey {
    case type, phase
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "state": self = .state(try ChromeState(from: decoder))
    case "presentMenu": self = .presentMenu(try MenuRequest(from: decoder))
    case "transition":
      self = .transition(started: try container.decode(String.self, forKey: .phase) == "start")
    case "chromeReady": self = .chromeReady
    case "documentStart": self = .documentStart
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type, in: container, debugDescription: "unknown message type \(type)")
    }
  }
}

/// A file the user picked, for the editor to attach.
public struct IntentFile: Encodable, Equatable, Sendable {
  public var name: String
  public var type: String
  /// The bytes, base64.
  public var data: String

  public init(name: String, type: String, data: Data) {
    self.name = name
    self.type = type
    self.data = data.base64EncodedString()
  }
}

/// A command of the page's formatting toolbar.
public enum FormattingCommand: String, CaseIterable, Encodable, Sendable {
  case slash, list, todo, link, tag, dedent, indent, up, down, dismiss
}

/// What a native control asks the page to do.
public enum ChromeIntent: Encodable, Equatable, Sendable {
  case back(entryId: Int)
  case tab(ChromeTab)
  case action(entryId: Int, id: String)
  case menu(entryId: Int, menuId: String, id: String)
  case command(FormattingCommand)
  case files([IntentFile])

  private enum CodingKeys: String, CodingKey {
    case type, entryId, tab, id, menuId, files
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .back(let entryId):
      try container.encode("back", forKey: .type)
      try container.encode(entryId, forKey: .entryId)
    case .tab(let tab):
      try container.encode("tab", forKey: .type)
      try container.encode(tab, forKey: .tab)
    case .action(let entryId, let id):
      try container.encode("action", forKey: .type)
      try container.encode(entryId, forKey: .entryId)
      try container.encode(id, forKey: .id)
    case .menu(let entryId, let menuId, let id):
      try container.encode("menu", forKey: .type)
      try container.encode(entryId, forKey: .entryId)
      try container.encode(menuId, forKey: .menuId)
      try container.encode(id, forKey: .id)
    case .command(let id):
      try container.encode("command", forKey: .type)
      try container.encode(id, forKey: .id)
    case .files(let files):
      try container.encode("files", forKey: .type)
      try container.encode(files, forKey: .files)
    }
  }
}
