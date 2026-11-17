public import Foundation
public import TypesShared

// The chrome protocol types are generated from `crates/types/src/chrome.rs`.

/// The chrome state that the page posts after every change.
public typealias ChromeState = ChromeMessageStateData

/// One row of a menu.
public typealias MenuAction = MenuItemActionData

extension IntentFile {
  /// A file with `bytes` as its contents.
  public init(name: String, type: String, bytes: Data) {
    self.init(name: name, type: type, data: bytes.base64EncodedString())
  }
}
