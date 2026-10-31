import Foundation

#if canImport(AppIntents)
  import AppIntents

  /// Siri / Shortcuts / Action-button quick capture (Plan 24): spools the
  /// text into the App Group capture inbox as an `ios-intent` envelope
  /// through the share extension's `CaptureInbox` (compiled into this target
  /// too — the shared-source pattern). Durability, not visibility: the app
  /// relays + drains the inbox into the capture-day daily note on its next
  /// launch/foreground, so the dialog says "Saved", never "added".
  ///
  /// `openAppWhenRun = false`: when the app is not running, iOS launches it
  /// in the background to run this — but `perform()` touches only Foundation
  /// and the App Group container, and never waits on the webview or graph.
  /// Deliberately not `@MainActor`: the file write must not queue behind
  /// app-boot main-thread work.
  @available(iOS 16.0, *)
  struct QuickNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Add quick note"
    static var description = IntentDescription(
      "Append a one-line note to today's daily note in Reflect.")
    static var openAppWhenRun = false

    /// Apple's default is `.alwaysAllowed` (runs on a locked device), and
    /// `.requiresAuthentication` still allows a locked iPhone driven from an
    /// unlocked paired Watch. Until the App Group container's file
    /// protection is verified for locked writes, the device performing the
    /// write must itself be unlocked; Face ID satisfies this invisibly from
    /// the lock screen.
    static var authenticationPolicy: IntentAuthenticationPolicy =
      .requiresLocalDeviceAuthentication

    @Parameter(title: "Note", requestValueDialog: "What do you want to note down?")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
      // `spoolText` folds whitespace to one line and returns false when
      // nothing printable remains — reprompt instead of claiming "Saved".
      guard try CaptureInbox.spoolText(text, source: "ios-intent") else {
        throw $text.needsValueError("What do you want to note down?")
      }
      return .result(dialog: "Saved")
    }
  }
#endif
