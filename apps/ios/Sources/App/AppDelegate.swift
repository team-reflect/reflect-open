import UIKit

/// The application delegate. It starts native crash reporting and connects
/// every scene to `SceneDelegate`.
@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // ggml registers every Metal buffer in a residency set and aborts at exit
    // while one is left, but the embedding model lives for the whole process.
    setenv("GGML_METAL_NO_RESIDENCY", "1", 1)
    #if !DEBUG
    NativeDiagnostics.start(runtime: "swift-native")
    #endif
    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: nil, sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}
