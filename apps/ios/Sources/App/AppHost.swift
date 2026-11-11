import UIKit
import os

/// Builds the parts of the shell and connects them: the Rust core, the
/// routes of the `reflect-app` scheme, the event bridge and the web view.
@MainActor
final class AppHost {
  let webView: ReflectWebView
  /// The page to load: the dev server in `REFLECT_DEV_URL`, or the bundled web app.
  let startURL: URL

  private let core: ReflectCore
  private let bridge = HostBridge()
  private let deepLinks: DeepLinks
  private let navigation: ExternalNavigation
  private var eventPump: Task<Void, Never>?

  init() throws {
    let core = try ReflectCore(config: .current(), openURL: Self.openFromCore)
    self.core = core
    let deepLinks = DeepLinks { [bridge] name, payload in bridge.emit(name, payload: payload) }
    self.deepLinks = deepLinks

    let devURL = ProcessInfo.processInfo.environment["REFLECT_DEV_URL"].flatMap(URL.init(string:))
    startURL = devURL ?? URL(string: AppSchemeHandler.indexURL) ?? URL(fileURLWithPath: "/")

    var shellCommands = HostCommands.all(deepLinks: deepLinks) { url in
      await UIApplication.shared.open(url)
    }
    var routes: [any SchemeRoute] = []
    #if DEBUG
    shellCommands.merge(SelfCheck.commands(bridge: bridge)) { _, new in new }
    routes.append(SelfCheckRoute())
    #endif
    let callers = TrustedCallers(devOrigin: devURL.flatMap(Self.origin(of:)))
    routes.append(HTTPProxy(callers: callers))
    routes.append(
      IPCRoute(
        dispatch: { [core] command, args, headers, body in
          await core.dispatch(command, args: args, headers: headers, body: body)
        },
        shellCommands: shellCommands,
        callers: callers))
    let assets = AssetSchemeHandler { [core] requestPath, rasterOnly in
      await core.resolveAsset(requestPath: requestPath, rasterOnly: rasterOnly)
    }
    webView = ReflectWebView(routes: routes, assets: assets, bridge: bridge)

    navigation = ExternalNavigation(startURL: startURL) { url in
      UIApplication.shared.open(url)
    }
    webView.navigationDelegate = navigation
    webView.uiDelegate = navigation

    eventPump = Task { [bridge, events = core.events] in
      for await event in events {
        bridge.emit(event.name, payload: event.payload)
      }
    }
  }

  deinit {
    eventPump?.cancel()
  }

  /// The system opened the app with `urls`.
  func open(_ urls: [URL]) {
    deepLinks.open(urls)
  }

  /// The scene came to the foreground: emits `host:foreground`.
  func didEnterForeground() {
    bridge.emit("host:foreground", payload: Data())
  }

  /// The scene went to the background: emits `host:background`.
  func didEnterBackground() {
    bridge.emit("host:background", payload: Data())
  }

  /// Opens a URL that a core command hands to the system, and returns
  /// whether an app opened it. It runs on a Rust thread and waits there for
  /// the system's answer. An absolute file path is refused.
  private static let openFromCore: @Sendable (String) -> Bool = { target in
    guard !target.hasPrefix("/"), let url = URL(string: target), url.scheme != nil,
      !Thread.isMainThread
    else { return false }
    let opened = OSAllocatedUnfairLock(initialState: false)
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      UIApplication.shared.open(url) { success in
        opened.withLock { $0 = success }
        done.signal()
      }
    }
    done.wait()
    return opened.withLock { $0 }
  }

  /// The origin of a URL as the `Origin` header spells it, such as
  /// `http://localhost:1420`: without the default port of the scheme.
  static func origin(of url: URL) -> String? {
    guard let scheme = url.scheme, let rawHost = url.host else { return nil }
    let host = rawHost.contains(":") ? "[\(rawHost)]" : rawHost
    let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
    guard let port = url.port, port != defaultPort else { return "\(scheme)://\(host)" }
    return "\(scheme)://\(host):\(port)"
  }
}

extension CoreConfig {
  /// The config of this app: the Documents directory, `Application Support/<bundle id>`
  /// (created when missing) and `Reflect/<version>`, the same values as the Tauri shell.
  static func current(fileManager: FileManager = .default, bundle: Bundle = .main) throws
    -> CoreConfig
  {
    let documents = try fileManager.url(
      for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let support = try fileManager.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let data = support.appendingPathComponent(bundle.bundleIdentifier ?? "app.reflect.ios")
    try fileManager.createDirectory(at: data, withIntermediateDirectories: true)
    let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return CoreConfig(
      documentDir: documents.path, dataDir: data.path, userAgent: "Reflect/\(version ?? "0.0.0")")
  }
}
