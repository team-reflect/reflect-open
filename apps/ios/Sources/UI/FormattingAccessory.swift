import ChromeKit
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

  init(webView: WKWebView) {
    self.webView = webView
    super.init()
    strip.onCommand = { [weak self] id in self?.send(.command(id)) }
    strip.onInsertImage = { [weak self] in self?.pickImages() }
    KeyboardTuning.accessoryProvider = { [weak self] view in self?.accessory(for: view) }
  }

  /// Follows the page's toolbar. The keyboard reloads its accessory only when
  /// the strip comes or goes, so a caret move never makes it flicker.
  func update(_ toolbar: ToolbarState?) {
    self.toolbar = toolbar
    if let toolbar {
      strip.update(toolbar)
    }
    if (toolbar != nil) != shown {
      contentView?.reloadInputViews()
    }
  }

  private func accessory(for view: UIView) -> UIView? {
    guard view.isDescendant(of: webView) else { return nil }
    contentView = view
    shown = toolbar != nil
    return shown ? strip : nil
  }

  private func pickImages() {
    var configuration = PHPickerConfiguration()
    configuration.filter = .images
    configuration.selectionLimit = 0
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    presenter()?.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    let providers = results.map(\.itemProvider)
    Task { [weak self] in
      var files: [IntentFile] = []
      for provider in providers {
        if let file = await Self.loadImage(provider) {
          files.append(file)
        }
      }
      if !files.isEmpty {
        self?.send(.files(files))
      }
    }
  }

  /// The image of `provider` as a file, in its own format.
  private static func loadImage(_ provider: NSItemProvider) async -> IntentFile? {
    guard
      let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) })
    else { return nil }
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
