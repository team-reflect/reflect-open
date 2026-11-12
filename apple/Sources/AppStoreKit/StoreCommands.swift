public import Foundation

/// The answer of one store command.
public enum StoreReply: Sendable, Equatable {
  /// A JSON value.
  case json(Data)
  /// The JSON value `null`: the answer of a command that returns nothing.
  case null
  /// An error with the wire shape of the core's `AppError`.
  case error(kind: String, message: String)

  fileprivate static func value(_ value: some Encodable) -> StoreReply {
    guard let json = try? JSONEncoder().encode(value) else {
      return .error(kind: "unknown", message: "the shell could not encode a reply")
    }
    return .json(json)
  }
}

/// One store command: takes the JSON object of arguments.
public typealias StoreCommand = @MainActor (Data) async -> StoreReply

/// The `plugin:iap` commands and the `plugin:app-store` commands that need no
/// window: subscriptions on a `StoreClient`.
@MainActor
public final class StoreCommands {
  /// The event for each transaction that arrives outside a purchase.
  public static let purchaseUpdatedEvent = "plugin:iap:purchaseUpdated"

  private let client: any StoreClient
  private let emit: @MainActor (String, Data) -> Void
  private var listener: Task<Void, Never>?

  /// `emit` delivers `purchaseUpdatedEvent` for each transaction that arrives
  /// after `start()`.
  public init(client: any StoreClient, emit: @escaping @MainActor (String, Data) -> Void) {
    self.client = client
    self.emit = emit
  }

  deinit {
    listener?.cancel()
  }

  /// Starts to listen for transactions that arrive outside a purchase. For
  /// each one it emits `purchaseUpdatedEvent` and then finishes the
  /// transaction. Call it once, when the app starts.
  public func start() {
    guard listener == nil else { return }
    let updates = client.updates()
    listener = Task { [emit] in
      for await update in updates {
        emit(Self.purchaseUpdatedEvent, Data())
        await update.finish()
      }
    }
  }

  /// The commands by name.
  public var commands: [String: StoreCommand] {
    [
      "plugin:iap|get_products": { [client] args in await Self.getProducts(client, args) },
      "plugin:iap|purchase": { [client] args in await Self.purchase(client, args) },
      "plugin:iap|get_product_status": { [client] args in
        await Self.getProductStatus(client, args)
      },
      "plugin:app-store|get_environment": { [client] _ in await Self.getEnvironment(client) },
      "plugin:app-store|sync": { [client] _ in await Self.sync(client) },
    ]
  }

  /// The arguments of the `plugin:iap` commands; each command reads its own field.
  private struct IAPArgs: Decodable {
    struct Payload: Decodable {
      var productIds: [String]?
      var productId: String?
    }
    var payload: Payload
  }

  private static func payload(_ args: Data) -> IAPArgs.Payload? {
    (try? JSONDecoder().decode(IAPArgs.self, from: args))?.payload
  }

  /// `get_products {payload: {productIds}}` answers `{products: [{productId, formattedPrice}]}`.
  private static func getProducts(_ client: any StoreClient, _ args: Data) async -> StoreReply {
    struct Response: Encodable {
      struct Item: Encodable {
        var productId: String
        var formattedPrice: String
      }
      var products: [Item]
    }
    guard let ids = payload(args)?.productIds else {
      return .error(kind: "parse", message: "iap get_products takes {payload: {productIds}}")
    }
    do {
      let products = try await client.products(for: ids)
      return .value(
        Response(
          products: products.map { .init(productId: $0.id, formattedPrice: $0.displayPrice) }))
    } catch {
      return .error(kind: "io", message: "Failed to fetch products: \(error.localizedDescription)")
    }
  }

  /// `purchase {payload: {productId}}` runs the purchase sheet. It answers
  /// `null` for a verified purchase and an error for any other outcome.
  private static func purchase(_ client: any StoreClient, _ args: Data) async -> StoreReply {
    guard let id = payload(args)?.productId else {
      return .error(kind: "parse", message: "iap purchase takes {payload: {productId}}")
    }
    do {
      switch try await client.purchase(id) {
      case nil:
        return .error(kind: "notFound", message: "Product not found")
      case .purchased:
        return .null
      case .unverified:
        return .error(kind: "io", message: "Transaction verification failed")
      case .cancelled:
        return .error(kind: "io", message: "Purchase cancelled by user")
      case .pending:
        return .error(kind: "io", message: "Purchase is pending")
      case .unknown:
        return .error(kind: "io", message: "Unknown purchase result")
      }
    } catch {
      return .error(kind: "io", message: "Purchase failed: \(error.localizedDescription)")
    }
  }

  /// `get_product_status {payload: {productId}}` answers `{isOwned}`: whether
  /// a verified transaction entitles the user to the product now.
  private static func getProductStatus(_ client: any StoreClient, _ args: Data) async
    -> StoreReply
  {
    struct Response: Encodable {
      var isOwned: Bool
    }
    guard let id = payload(args)?.productId else {
      return .error(kind: "parse", message: "iap get_product_status takes {payload: {productId}}")
    }
    return .value(Response(isOwned: await client.isEntitled(to: id)))
  }

  /// `get_environment` answers `{environment}`: `Production` for an App Store
  /// install, `Sandbox` for TestFlight and development installs, `Xcode` for
  /// a StoreKit configuration run.
  private static func getEnvironment(_ client: any StoreClient) async -> StoreReply {
    struct Response: Encodable {
      var environment: String
    }
    guard let environment = await client.environment() else {
      return .error(kind: "io", message: "the app transaction is unavailable")
    }
    return .value(Response(environment: environment))
  }

  /// `sync` fetches transactions and subscription status from the App Store
  /// again. The system can show its sign-in prompt.
  private static func sync(_ client: any StoreClient) async -> StoreReply {
    do {
      try await client.sync()
      return .null
    } catch {
      return .error(kind: "io", message: "AppStore.sync failed: \(error.localizedDescription)")
    }
  }
}
