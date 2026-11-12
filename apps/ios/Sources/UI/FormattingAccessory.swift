import ChromeKit
import GameController
import KeyboardKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Puts the ``FormattingStrip`` above the keyboard while an editor of the page
/// has focus, and sends its taps to the page.
@MainActor
final class FormattingAccessory: NSObject, PHPickerViewControllerDelegate {
  /// Sends an intent to the page.
  var send: (ChromeIntent) -> Void = { _ in }
  /// The controller that presents the photo picker.
  var presenter: () -> UIViewController? = { nil }

  private let webView: WKWebView
  private let strip = FormattingStrip()
  private var toolbar: ToolbarState?
  /// The web content view that asked for the accessory last.
  private weak var contentView: UIView?
  /// Whether the strip was the last accessory of `contentView`.
  private var shown = false
  /// Set while the strip is off for a keyboard relayout.
  private var relayout = false
  /// Loads the picked images; a new document cancels it.
  private var loading: Task<Void, Never>?

  init(webView: WKWebView) {
    self.webView = webView
    super.init()
    strip.onCommand = { [weak self] id in self?.send(.command(id)) }
    strip.onInsertImage = { [weak self] in self?.pickImages() }
    KeyboardTuning.accessoryProvider = { [weak self] view in self?.accessory(for: view) }
    for name in [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
      NotificationCenter.default.addObserver(
        self, selector: #selector(keyboardDidChange), name: name, object: nil)
    }
  }

  /// A hardware keyboard came or went: the strip shows only with the
  /// on-screen keyboard.
  @objc private func keyboardDidChange() {
    contentView?.reloadInputViews()
  }

  /// Follows the page's toolbar. The keyboard reloads its accessory only when
  /// the strip comes or goes, so a caret move never makes it flicker.
  func update(_ toolbar: ToolbarState?) {
    self.toolbar = toolbar
    if let toolbar {
      strip.update(toolbar)
    }
    if wantsStrip != shown, !relayout {
      contentView?.reloadInputViews()
    }
  }

  /// The strip shows only with the on-screen keyboard.
  private var wantsStrip: Bool {
    toolbar != nil && GCKeyboard.coalesced == nil
  }

  /// A new document: the images of an earlier pick never reach it.
  func reset() {
    loading?.cancel()
    loading = nil
  }

  /// Lays the keyboard out again after the window changed size: the strip
  /// goes away for 0.1 s and comes back. With the strip up through a resize
  /// (iPhone Duo posture), UIKit reports keyboard frames in the old
  /// orientation, and WebKit sizes the page's visual viewport from them.
  func sizeDidChange() {
    guard shown, let contentView else { return }
    relayout = true
    contentView.reloadInputViews()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak contentView] in
      guard let self else { return }
      self.relayout = false
      contentView?.reloadInputViews()
    }
  }

  private func accessory(for view: UIView) -> UIView? {
    guard view.isDescendant(of: webView) else { return nil }
    contentView = view
    shown = wantsStrip && !relayout
    return shown ? strip : nil
  }

  /// The most images one pick inserts. Each image crosses the bridge as
  /// base64 in its own script.
  private static let imageLimit = 10

  private func pickImages() {
    var configuration = PHPickerConfiguration()
    configuration.filter = .images
    configuration.selectionLimit = Self.imageLimit
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    presenter()?.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    let providers = results.map(\.itemProvider)
    loading?.cancel()
    loading = Task { [weak self] in
      // One intent per image, in the picked order, keeps each script small.
      for provider in providers {
        let file = await Self.loadImage(provider)
        guard !Task.isCancelled else { return }
        if let file {
          self?.send(.files([file]))
        }
      }
    }
  }

  /// The image of `provider` as a file: JPEG, PNG, and GIF as they are,
  /// any other format (HEIC) as JPEG, which every web engine shows.
  private static func loadImage(_ provider: NSItemProvider) async -> IntentFile? {
    guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { return nil }
    let kept: [UTType] = [.jpeg, .png, .gif]
    let type =
      provider.registeredContentTypes.first { registered in
        kept.contains { registered.conforms(to: $0) }
      } ?? .jpeg
    let data: Data? = await withCheckedContinuation { continuation in
      _ = provider.loadDataRepresentation(for: type) { data, _ in
        continuation.resume(returning: data)
      }
    }
    guard let data else { return nil }
    let name = "\(provider.suggestedName ?? "Image").\(type.preferredFilenameExtension ?? "jpg")"
    return IntentFile(name: name, type: type.preferredMIMEType ?? "image/jpeg", data: data)
  }
}
