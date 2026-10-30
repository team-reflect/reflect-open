import Tauri
import UIKit
import WebKit

/// Mirrors `SizeClassPayload` in `src/models.rs` and
/// `packages/core/src/ipc/scene-plugin.ts`.
struct SizeClassPayload: Encodable {
  let horizontal: String
}

/// The window scene's traits, as iPadOS apps lay out by them. The webview
/// renders the desktop workspace while its window is horizontally regular
/// and the phone shell while it is compact (Slide Over, a narrow Split View
/// pane, a small Stage Manager window), so the size class has to come from
/// UIKit: the CSS width alone cannot say where iPadOS draws the line.
class ScenePlugin: Plugin {
  private weak var webview: WKWebView?
  private var observer: SizeClassObserverView?

  @objc public override func load(webview: WKWebView) {
    self.webview = webview
    let observer = SizeClassObserverView { [weak self] sizeClass in
      self?.publish(sizeClass)
    }
    webview.addSubview(observer)
    self.observer = observer
  }

  /// The webview's current horizontal size class. Trait collections are
  /// main-thread state, so the read hops there before resolving.
  @objc public func sizeClass(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let sizeClass = self.webview?.traitCollection.horizontalSizeClass ?? .unspecified
      invoke.resolve(SizeClassPayload(horizontal: Self.name(of: sizeClass)))
    }
  }

  private func publish(_ sizeClass: UIUserInterfaceSizeClass) {
    do {
      try trigger("sizeClassChanged", data: SizeClassPayload(horizontal: Self.name(of: sizeClass)))
    } catch {
      Logger.error("[scene] failed to publish a size class change: \(error)")
    }
  }

  /// Only `compact` asks for the phone shell: a window whose traits are not
  /// resolved yet (`unspecified`) is an iPad window at full size.
  private static func name(of sizeClass: UIUserInterfaceSizeClass) -> String {
    sizeClass == .compact ? "compact" : "regular"
  }
}

/// An invisible subview of the webview that inherits its window's traits and
/// reports each horizontal size class change. A view, not a notification:
/// UIKit only delivers trait changes through the view hierarchy.
final class SizeClassObserverView: UIView {
  private let onChange: (UIUserInterfaceSizeClass) -> Void

  init(onChange: @escaping (UIUserInterfaceSizeClass) -> Void) {
    self.onChange = onChange
    super.init(frame: .zero)
    isHidden = true
    isUserInteractionEnabled = false
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitHorizontalSizeClass.self]) {
        (view: SizeClassObserverView, _: UITraitCollection) in
        view.onChange(view.traitCollection.horizontalSizeClass)
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // iOS 16's path; iOS 17+ reports through the registration above instead.
  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if #available(iOS 17.0, *) { return }
    if previousTraitCollection?.horizontalSizeClass != traitCollection.horizontalSizeClass {
      onChange(traitCollection.horizontalSizeClass)
    }
  }
}

@_cdecl("init_plugin_scene")
public func initPlugin() -> Plugin {
  return ScenePlugin()
}
