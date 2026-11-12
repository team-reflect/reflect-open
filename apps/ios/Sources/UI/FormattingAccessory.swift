import ChromeKit
import GameController
import KeyboardKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit
import os

/// Puts the ``FormattingStrip`` above the keyboard while an editor of the page
/// has focus, and sends its taps to the page.
@MainActor
final class FormattingAccessory: NSObject, PHPickerViewControllerDelegate {
  private static let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.reflect.ios", category: "chrome")

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
  /// Loads the picked images, after the images of earlier picks.
  private var loading: Task<Void, Never>?
  /// Counts documents, so the loads of an earlier document send nothing.
  private var document = 0
  /// Whether the on-screen keyboard is up, from its last frame. Before the
  /// first frame, a connected hardware keyboard means no on-screen keyboard.
  private var softwareKeyboard: Bool?
  /// The presented photo picker; a new document closes it.
  private weak var picker: PHPickerViewController?

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
    NotificationCenter.default.addObserver(
      self, selector: #selector(keyboardFrameWillChange(_:)),
      name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
  }

  /// A hardware keyboard came or went: the strip shows only with the
  /// on-screen keyboard.
  @objc private func keyboardDidChange() {
    softwareKeyboard = nil
    reloadIfNeeded()
  }

  /// The tallest keyboard frame, without the strip, that is only the
  /// shortcut bar of a hardware keyboard.
  private static let shortcutBarHeight: CGFloat = 120

  /// The keyboard moved: it is the on-screen keyboard when it is taller than
  /// the shortcut bar of a hardware keyboard.
  @objc private func keyboardFrameWillChange(_ notification: Notification) {
    guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
      let screen = webView.window?.screen,
      (notification.object as? UIScreen).map({ $0 === screen }) ?? true
    else { return }
    let height = frame.intersection(screen.bounds).height - (shown ? strip.bounds.height : 0)
    softwareKeyboard = height > 0 ? height > Self.shortcutBarHeight : nil
    reloadIfNeeded()
  }

  /// Follows the page's toolbar. The keyboard reloads its accessory only when
  /// the strip comes or goes, so a caret move never makes it flicker.
  func update(_ toolbar: ToolbarState?) {
    self.toolbar = toolbar
    if let toolbar {
      strip.update(toolbar)
    }
    reloadIfNeeded()
  }

  /// The keyboard reloads its accessory only when the strip comes or goes.
  private func reloadIfNeeded() {
    if wantsStrip != shown, !relayout {
      contentView?.reloadInputViews()
    }
  }

  /// The strip shows only with the on-screen keyboard.
  private var wantsStrip: Bool {
    toolbar != nil && (softwareKeyboard ?? (GCKeyboard.coalesced == nil))
  }

  /// A new document: the images of an earlier pick never reach it.
  func reset() {
    document += 1
    loading?.cancel()
    loading = nil
    picker?.dismiss(animated: true)
    picker = nil
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
    // HEIC and RAW photos come as JPEG.
    configuration.preferredAssetRepresentationMode = .compatible
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    self.picker = picker
    presenter()?.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    // A cancel keeps the images of an earlier pick that still load.
    guard !results.isEmpty else { return }
    let providers = results.map(\.itemProvider)
    let previous = loading
    let document = document
    loading = Task { [weak self] in
      // The images of an earlier pick go first.
      await previous?.value
      // One intent per image, in the picked order, keeps each script small.
      for provider in providers {
        let file = await Self.loadImage(provider)
        guard let self, self.document == document else { return }
        if let file {
          self.send(.files([file]))
        } else {
          Self.logger.error("picked image did not load: \(provider.registeredContentTypes)")
        }
      }
    }
  }

  /// The image of `provider` as a file: JPEG, PNG, and GIF as they are,
  /// any other format (HEIC, RAW) as JPEG, which every web engine shows.
  private static func loadImage(_ provider: NSItemProvider) async -> IntentFile? {
    guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { return nil }
    let base = provider.suggestedName ?? "Image"
    let kept: [UTType] = [.jpeg, .png, .gif]
    if let type = provider.registeredContentTypes.first(where: { registered in
      kept.contains { registered.conforms(to: $0) }
    }) {
      let data: Data? = await withCheckedContinuation { continuation in
        _ = provider.loadDataRepresentation(for: type) { data, _ in
          continuation.resume(returning: data)
        }
      }
      guard let data else { return nil }
      return IntentFile(
        name: "\(base).\(type.preferredFilenameExtension ?? "jpg")",
        type: type.preferredMIMEType ?? "image/jpeg", data: data)
    }
    // No kept format: decode the image and encode it as JPEG.
    guard provider.canLoadObject(ofClass: UIImage.self) else { return nil }
    let data: Data? = await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
        continuation.resume(returning: (object as? UIImage)?.jpegData(compressionQuality: 0.9))
      }
    }
    guard let data else { return nil }
    return IntentFile(name: "\(base).jpg", type: "image/jpeg", data: data)
  }
}
