import Foundation
import WebKit

/// Handles the `reflect-app` scheme, the origin of the web app. A request
/// goes to the first route whose prefix matches its path. Every other path is
/// a static file of `WebBundle`.
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "reflect-app"
  static let indexURL = "reflect-app://localhost/index.html"

  private let routes: [any SchemeRoute]
  /// The tasks that WebKit started and that did not end yet.
  private var tasks: [ObjectIdentifier: SchemeTask] = [:]

  init(routes: [any SchemeRoute] = []) {
    self.routes = routes
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let id = ObjectIdentifier(urlSchemeTask)
    let task = SchemeTask(urlSchemeTask)
    tasks[id] = task
    task.onEnd { [weak self] in
      self?.tasks[id] = nil
    }

    let path = task.request.url?.path ?? "/"
    if let route = routes.first(where: { path.hasPrefix($0.pathPrefix) }) {
      route.start(task)
      return
    }
    Task {
      task.reply(await WebBundle.reply(forPath: path))
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    tasks[ObjectIdentifier(urlSchemeTask)]?.stop()
  }
}
