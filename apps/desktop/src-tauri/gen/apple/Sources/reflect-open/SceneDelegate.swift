import UIKit

/// Reflect's UIScene lifecycle, adapted onto the app-delegate lifecycle that
/// tao (the windowing layer of Tauri 2) implements.
///
/// Apps linked against the iOS 27 SDK must adopt UIScene or UIKit aborts them
/// at launch. Tauri 2 is pinned to tao 0.35, whose own scene support engages
/// only for multi-scene apps and then crashes release builds
/// (tauri-apps/tao#1244), so Info.plist declares a single-scene manifest
/// naming this delegate instead. tao keeps running as a plain app delegate,
/// which leaves two gaps this file closes: tao creates its window before any
/// scene exists (`SceneWindows` hands it to the scene), and it listens for URL
/// opens and foreground/background transitions on app-delegate callbacks that
/// UIKit stops calling once scenes are adopted (the delegate relays each scene
/// event to its app-delegate counterpart).
///
/// Retire this once Tauri ships a tao that adopts scenes for single-scene apps
/// (tauri-apps/tao#1308).
@objc(ReflectSceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  /// The home-screen quick action's `UIApplicationShortcutItemType`
  /// (Info.plist `UIApplicationShortcutItems`).
  private static let recordAudioShortcutType = "app.reflect.record-audio"

  private var application: UIApplication { .shared }
  private var appDelegate: UIApplicationDelegate? { application.delegate }

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    if let windowScene = scene as? UIWindowScene {
      SceneWindows.connect(windowScene)
    }
    // Whatever launched the app arrives with the connection, never through
    // the per-event callbacks below.
    open(connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach(continueUserActivity)
    if let shortcutItem = connectionOptions.shortcutItem {
      _ = performShortcut(shortcutItem)
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    if let windowScene = scene as? UIWindowScene {
      SceneWindows.disconnect(windowScene)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueUserActivity(userActivity)
  }

  func windowScene(
    _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(performShortcut(shortcutItem))
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground?(application)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive?(application)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive?(application)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground?(application)
  }

  /// tao turns these into `RunEvent::Opened` (the widget's
  /// `reflect://record-audio`, handled in `src/lib.rs`).
  private func open(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      _ = appDelegate?.application?(application, open: context.url, options: [:])
    }
  }

  private func continueUserActivity(_ userActivity: NSUserActivity) {
    _ = appDelegate?.application?(
      application, continue: userActivity, restorationHandler: { _ in })
  }

  /// "Record audio" takes the Siri intent's route to the recording plugin
  /// (`RecordingIntents.swift`); the name mirrors
  /// `RecordingPlugin.startRequestedNotification`.
  private func performShortcut(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
    guard shortcutItem.type == Self.recordAudioShortcutType else { return false }
    NotificationCenter.default.post(
      name: Notification.Name("app.reflect.recording.start-requested"), object: nil)
    return true
  }
}

/// Moves windows that have no scene into the app's window scene, the only
/// place a window is displayed once the app adopts scenes. tao creates its
/// window from `application(_:didFinishLaunchingWithOptions:)`, before UIKit
/// connects the scene, and no UIKit API lists windows without one — so windows
/// are recorded as they become visible, starting before tao runs. With one
/// scene, every visible window belongs in it. The system can also disconnect
/// a background scene to reclaim memory and connect a fresh one when the user
/// returns; the windows it held move to the new scene.
@MainActor
private enum SceneWindows {
  private static weak var scene: UIWindowScene?
  private static var waitingForScene: [UIWindow] = []
  private static let attached = NSHashTable<UIWindow>.weakObjects()

  static func observe() {
    NotificationCenter.default.addObserver(
      forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main
    ) { notification in
      guard let window = notification.object as? UIWindow else { return }
      MainActor.assumeIsolated { adopt(window) }
    }
  }

  static func connect(_ windowScene: UIWindowScene) {
    scene = windowScene
    let windows = waitingForScene
    waitingForScene.removeAll()
    for window in windows {
      attach(window, to: windowScene)
    }
  }

  static func disconnect(_ windowScene: UIWindowScene) {
    guard windowScene === scene else { return }
    scene = nil
    waitingForScene = attached.allObjects
  }

  private static func adopt(_ window: UIWindow) {
    guard window.windowScene == nil else { return }
    if let scene {
      attach(window, to: scene)
    } else if !waitingForScene.contains(window) {
      waitingForScene.append(window)
    }
  }

  private static func attach(_ window: UIWindow, to windowScene: UIWindowScene) {
    attached.add(window)
    window.windowScene = windowScene
    window.makeKeyAndVisible()
  }
}

/// Called once from `main.mm` before Tauri boots, so tao's first window is
/// already observed when it appears.
@_cdecl("reflect_observe_scene_windows")
public func reflectObserveSceneWindows() {
  MainActor.assumeIsolated { SceneWindows.observe() }
}
