import Foundation
import TypesShared

/// The quick note defaults the app mirrors into the App Group container
/// (`capture_quick_note_defaults_write` in `capture.rs`). A missing or
/// unreadable file means no defaults.
public enum QuickNoteDefaults {
  /// The parent bullet set in Settings, or nil to append at the end of the note.
  public static func parent() -> String? {
    guard
      let container = CaptureInbox.containerUrl(),
      let data = try? Data(contentsOf: container.appendingPathComponent(CaptureConstants.quickNoteDefaultsFile)),
      let file = try? JSONDecoder().decode(QuickNoteDefaultsFile.self, from: data),
      file.version == 1
    else {
      return nil
    }
    return CaptureInbox.foldedParent(file.parent)
  }
}
