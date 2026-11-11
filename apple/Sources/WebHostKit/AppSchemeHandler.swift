public import Foundation
public import WebKit

/// Handles the `reflect-app` scheme, the origin of the web app. A request
/// goes to the first route whose prefix matches its path. Every other path is
/// a static file of `WebBundle`.
@MainActor
public final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
  public nonisolated static let scheme = "reflect-app"
  public nonisolated static let indexURL = "reflect-app://localhost/index.html"

  private let routes: [any SchemeRoute]
  private let tasks = SchemeTasks()

  public init(routes: [any SchemeRoute] = []) {
    self.routes = routes
  }

  public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let task = tasks.start(urlSchemeTask)

    let path = task.request.url?.path ?? "/"
    if let route = routes.first(where: { path.hasPrefix($0.pathPrefix) }) {
      route.start(task)
      return
    }
    Task {
      task.reply(await WebBundle.reply(forPath: path))
    }
  }

  public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    tasks.stop(urlSchemeTask)
  }
}
