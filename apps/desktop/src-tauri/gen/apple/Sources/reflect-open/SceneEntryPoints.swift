import ObjectiveC
import UIKit

/// OS entry points that the scene lifecycle hands to the scene instead of the
/// app delegate.
///
/// Reflect declares a scene manifest (`ios.project.yml`) so tao creates its
/// window inside the scene. On the scene lifecycle the home-screen quick action
/// reaches the scene delegate, and a cold launch's quick action or URL arrives
/// only in the scene's connection options. tao's scene delegate reads neither,
/// so this adds the quick-action handler to it and, once tao has connected the
/// scene, delivers the connection options the way a running app receives them:
/// the quick action through the notification the Siri intents post
/// (`RecordingIntents.swift`), URLs through tao's own `scene:openURLContexts:`
/// to the Rust shell. The names mirror the constants in
/// `plugins/tauri-plugin-recording/ios/Sources/RecordingPlugin.swift`.
private enum SceneEntryPoints {
  /// The quick action's `UIApplicationShortcutItemType` (`ios.project.yml`).
  static let recordShortcutType = "app.reflect.record-audio"
  static let startRecordingRequested = Notification.Name("app.reflect.recording.start-requested")
  /// tao registers its scene delegate class under this name before
  /// `UIApplicationMain` runs (scene sessions restore it by name), so it exists
  /// once launching finishes, before the first scene connects.
  static let sceneDelegateClassName = "TaoSceneDelegate"

  private static var launchObserver: NSObjectProtocol?

  static func install() {
    launchObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didFinishLaunchingNotification,
      object: nil,
      queue: nil
    ) { _ in
      if let launchObserver {
        NotificationCenter.default.removeObserver(launchObserver)
      }
      launchObserver = nil
      // A tao that renames its delegate degrades to quick actions and
      // cold-launch URLs that only open the app.
      guard let delegateClass = NSClassFromString(sceneDelegateClassName) else { return }
      addQuickActionHandler(to: delegateClass)
      deliverConnectionOptions(of: delegateClass)
    }
  }

  /// Adds `windowScene:performActionForShortcutItem:completionHandler:`, which
  /// tao's delegate does not implement. A future delegate that does keeps its
  /// own.
  private static func addQuickActionHandler(to delegateClass: AnyClass) {
    let selector = #selector(
      UIWindowSceneDelegate.windowScene(_:performActionFor:completionHandler:))
    guard class_getInstanceMethod(delegateClass, selector) == nil else { return }
    let block: @convention(block) (
      AnyObject, UIWindowScene, UIApplicationShortcutItem, @escaping (Bool) -> Void
    ) -> Void = { _, _, item, completion in
      completion(performQuickAction(item))
    }
    class_addMethod(delegateClass, selector, imp_implementationWithBlock(block), "v@:@@@?")
  }

  /// Wraps tao's `scene:willConnectToSession:options:` to deliver a cold
  /// launch's quick action and URLs after tao has connected the scene, which
  /// is when the app and its plugins are set up.
  private static func deliverConnectionOptions(of delegateClass: AnyClass) {
    let selector = #selector(UISceneDelegate.scene(_:willConnectTo:options:))
    guard let method = class_getInstanceMethod(delegateClass, selector) else { return }
    typealias WillConnect = @convention(c) (
      AnyObject, Selector, UIScene, UISceneSession, UIScene.ConnectionOptions
    ) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: WillConnect.self)
    let block: @convention(block) (
      AnyObject, UIScene, UISceneSession, UIScene.ConnectionOptions
    ) -> Void = { delegate, scene, session, options in
      original(delegate, selector, scene, session, options)
      if !options.urlContexts.isEmpty {
        scene.delegate?.scene?(scene, openURLContexts: options.urlContexts)
      }
      if let item = options.shortcutItem {
        _ = performQuickAction(item)
      }
    }
    method_setImplementation(method, imp_implementationWithBlock(block))
  }

  private static func performQuickAction(_ item: UIApplicationShortcutItem) -> Bool {
    guard item.type == recordShortcutType else { return false }
    NotificationCenter.default.post(name: startRecordingRequested, object: nil)
    return true
  }
}

@_cdecl("reflect_install_scene_entry_points")
public func reflectInstallSceneEntryPoints() {
  SceneEntryPoints.install()
}
