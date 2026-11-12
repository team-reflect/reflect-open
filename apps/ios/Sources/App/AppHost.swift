import AuthenticationServices
import UIKit
import WebHostKit
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
  private let navigation: ExternalNavigation
  private let webAuth: WebAuthCapability
  private let store: StoreCapability
  private let recording: RecordingCapability
  private var eventPump: Task<Void, Never>?

  init() throws {
    let core = try ReflectCore(config: .current(), openURL: Self.openFromCore)
    self.core = core

    let devURL = ProcessInfo.processInfo.environment["REFLECT_DEV_URL"].flatMap(URL.init(string:))
    startURL = devURL ?? URL(string: AppSchemeHandler.indexURL) ?? URL(fileURLWithPath: "/")

    // The web view exists only after the capabilities: they read its window later.
    weak var presenter: UIView?
    let emit: @MainActor (String, Data) -> Void = { [bridge] name, payload in
      bridge.emit(name, payload: payload)
    }
    let webAuth = WebAuthCapability { presenter?.window ?? ASPresentationAnchor() }
    self.webAuth = webAuth
    let store = StoreCapability(scene: { presenter?.window?.windowScene }, emit: emit)
    self.store = store
    let recording = RecordingCapability(emit: emit)
    self.recording = recording

    var shellCommands: [String: ShellCommand] = [:]
    for commands in [
      HostCommands.all { url in await UIApplication.shared.open(url) },
      HapticsCapability.commands, webAuth.commands, store.commands, recording.commands,
    ] {
      shellCommands.merge(commands) { _, _ in
        preconditionFailure("two capabilities answer the same command")
      }
    }

    let callers = TrustedCallers(devOrigin: devURL?.webOrigin)
    let routes: [any SchemeRoute] = [
      HTTPProxy(callers: callers),
      IPCRoute(
        dispatch: { [core] command, args, headers, body in
          await core.dispatch(command, args: args, headers: headers, body: body)
        },
        shellCommands: shellCommands,
        callers: callers),
    ]
    let assets = AssetSchemeHandler { [core] requestPath, query, range in
      await core.resolveAsset(requestPath: requestPath, query: query, range: range)
    }
    webView = ReflectWebView(routes: routes, assets: assets, bridge: bridge)
    presenter = webView

    navigation = ExternalNavigation(
      startURL: startURL,
      openURL: { url in UIApplication.shared.open(url) },
      warn: { message in ReflectCore.log(.warn, message) })
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

  /// The system opened the app with `urls`. `reflect://record-audio` asks for
  /// a recording; the page gets every other URL as a `host:open-url` event
  /// with a `string[]` payload.
  func open(_ urls: [URL]) {
    let links = urls.filter { !($0.scheme == "reflect" && $0.host == "record-audio") }
    if links.count < urls.count {
      recording.requestRecording()
    }
    if !links.isEmpty,
      let payload = try? JSONSerialization.data(withJSONObject: links.map(\.absoluteString))
    {
      bridge.emit("host:open-url", payload: payload)
    }
  }

  /// The user chose a quick action of the app icon. Returns whether the app has that action.
  func perform(_ shortcut: UIApplicationShortcutItem) -> Bool {
    guard shortcut.type == "app.reflect.record-audio" else { return false }
    recording.requestRecording()
    return true
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
