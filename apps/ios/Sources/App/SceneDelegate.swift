import UIKit

/// Creates the window of the app's single scene with `RootViewController` as
/// its root, and passes the scene's URLs, quick actions and foreground state
/// to the host.
@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var host: AppHost? {
    (window?.rootViewController as? RootViewController)?.host
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    let root = RootViewController()
    window.rootViewController = root
    window.makeKeyAndVisible()
    self.window = window
    root.host?.open(connectionOptions.urlContexts.map(\.url))
    if let shortcut = connectionOptions.shortcutItem {
      _ = root.host?.perform(shortcut)
    }
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(host?.perform(shortcutItem) ?? false)
  }

  func scene(_ scene: UIScene, openURLContexts urlContexts: Set<UIOpenURLContext>) {
    host?.open(urlContexts.map(\.url))
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    host?.didEnterForeground()
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    host?.didEnterBackground()
  }
}
