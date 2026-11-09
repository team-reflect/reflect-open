import Foundation

/// The quick note defaults the app mirrors into the App Group container
/// (`capture_quick_note_defaults_write` in `capture.rs`). A missing or
/// unreadable file means no defaults.
enum QuickNoteDefaults {
  static let fileName = "quick-note.json"

  private struct File: Decodable {
    var version: Int
    var parent: String?
  }

  /// The parent bullet set in Settings, or nil to append at the end of the note.
  static func parent() -> String? {
    guard
      let container = CaptureInbox.containerUrl(),
      let data = try? Data(contentsOf: container.appendingPathComponent(fileName)),
      let file = try? JSONDecoder().decode(File.self, from: data),
      file.version == 1
    else {
      return nil
    }
    return file.parent.flatMap(CaptureInbox.foldedParent)
  }
}
