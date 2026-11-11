/// Handles the requests of `reflect-app` paths that start with `pathPrefix`.
@MainActor
public protocol SchemeRoute {
  var pathPrefix: String { get }
  func start(_ task: SchemeTask)
}
