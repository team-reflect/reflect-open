import Foundation
import WebKit

/// Handles the `reflect-app` scheme, the origin of the web app. It serves the
/// static files of `WebBundle`.
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "reflect-app"
  static let indexURL = "reflect-app://localhost/index.html"

  /// The tasks that WebKit started and did not stop yet. A reply goes only to a live task.
  private var liveTasks: Set<ObjectIdentifier> = []

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let id = ObjectIdentifier(urlSchemeTask)
    liveTasks.insert(id)
    let path = urlSchemeTask.request.url?.path ?? "/"
    Task {
      let reply = await WebBundle.reply(forPath: path)
      guard liveTasks.remove(id) != nil else { return }
      send(reply, to: urlSchemeTask)
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    liveTasks.remove(ObjectIdentifier(urlSchemeTask))
  }

  private func send(_ reply: SchemeReply, to urlSchemeTask: any WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: reply.statusCode, httpVersion: "HTTP/1.1",
        headerFields: reply.headers)
    else {
      urlSchemeTask.didFailWithError(URLError(.badURL))
      return
    }
    urlSchemeTask.didReceive(response)
    urlSchemeTask.didReceive(reply.body)
    urlSchemeTask.didFinish()
  }
}
