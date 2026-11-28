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
  /// `nil` until the monitor reports the first path.
  private var status: NetworkStatus?
  private var waiters: [CheckedContinuation<NetworkStatus, Never>] = []

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
    for waiter in waiters {
      waiter.resume(returning: next)
    }
    waiters = []
    emit("plugin:network:changed", json)
  }

  /// The current status, after the monitor reports the first path.
  private func currentStatus() async -> NetworkStatus {
    if let status {
      return status
    }
    return await withCheckedContinuation { waiters.append($0) }
  }

  var commands: [ShellCommandName: ShellCommand] {
    [.networkStatus: { [self] _ in .value(await currentStatus()) }]
  }
}
