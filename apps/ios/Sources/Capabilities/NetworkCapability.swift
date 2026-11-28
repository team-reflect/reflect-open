import Foundation
import Network
import TypesShared
import WebHostKit

/// The `plugin:network` command and event: whether the current connection is
/// expensive (cellular, a personal hotspot, or Low Data Mode). The web app
/// asks the user before it downloads large files over such a connection.
@MainActor
final class NetworkCapability {
  private let monitor = NWPathMonitor()
  private let emit: @MainActor (String, Data) -> Void
  private var status = NetworkStatus(expensive: false)

  /// `emit` delivers each change as `plugin:network:changed`.
  init(emit: @escaping @MainActor (String, Data) -> Void) {
    self.emit = emit
    monitor.pathUpdateHandler = { [weak self] path in
      let status = NetworkStatus(expensive: path.isExpensive || path.isConstrained)
      Task { @MainActor in self?.update(status) }
    }
    monitor.start(queue: DispatchQueue(label: "app.reflect.network", qos: .utility))
  }

  private func update(_ next: NetworkStatus) {
    guard next != status, let json = try? JSONEncoder().encode(next) else { return }
    status = next
    emit("plugin:network:changed", json)
  }

  var commands: [ShellCommandName: ShellCommand] {
    [.networkStatus: { [weak self] _ in .value(self?.status ?? NetworkStatus(expensive: false)) }]
  }
}
