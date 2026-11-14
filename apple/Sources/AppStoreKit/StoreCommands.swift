public import Foundation
public import TypesShared

/// The answer of one store command.
public enum StoreReply: Sendable, Equatable {
  /// A JSON value.
  case json(Data)
  /// The JSON value `null`: the answer of a command that returns nothing.
  case null
  /// An error of the core's `AppError` contract.
  case error(AppError)

  fileprivate static func value(_ value: some Encodable) -> StoreReply {
    guard let json = try? JSONEncoder().encode(value) else {
      return .error(.unknown(.init(message: "the shell could not encode a reply")))
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
      ShellCommandName.iapGetProducts.rawValue: { [client] args in
        await Self.getProducts(client, args)
      },
      ShellCommandName.iapPurchase.rawValue: { [client] args in await Self.purchase(client, args) },
      ShellCommandName.iapGetProductStatus.rawValue: { [client] args in
        await Self.getProductStatus(client, args)
      },
      ShellCommandName.appStoreGetEnvironment.rawValue: { [client] _ in
        await Self.getEnvironment(client)
      },
      ShellCommandName.appStoreSync.rawValue: { [client] _ in await Self.sync(client) },
    ]
  }

  /// The product of `purchase` and `get_product_status`.
  private static func productId(_ args: Data) -> String? {
    (try? JSONDecoder().decode(IapProductArgs.self, from: args))?.payload.productId
  }

  /// `get_products {payload: {productIds}}` answers `{products: [{productId, formattedPrice}]}`.
  private static func getProducts(_ client: any StoreClient, _ args: Data) async -> StoreReply {
    guard
      let ids = (try? JSONDecoder().decode(IapProductsArgs.self, from: args))?.payload.productIds
    else {
      return .error(.parse(.init(message: "iap get_products takes {payload: {productIds}}")))
    }
    do {
      let products = try await client.products(for: ids)
      return .value(
        IapProducts(
          products: products.map { IapProduct(productId: $0.id, formattedPrice: $0.displayPrice) }))
    } catch {
      return .error(.io(.init(message: "Failed to fetch products: \(error.localizedDescription)")))
    }
  }

  /// `purchase {payload: {productId}}` runs the purchase sheet. It answers
  /// `null` for a verified purchase and an error for any other outcome.
  private static func purchase(_ client: any StoreClient, _ args: Data) async -> StoreReply {
    guard let id = productId(args) else {
      return .error(.parse(.init(message: "iap purchase takes {payload: {productId}}")))
    }
    do {
      switch try await client.purchase(id) {
      case nil:
        return .error(.notFound(.init(message: "Product not found")))
      case .purchased:
        return .null
      case .unverified:
        return .error(.io(.init(message: "Transaction verification failed")))
      case .cancelled:
        return .error(.io(.init(message: "Purchase cancelled by user")))
      case .pending:
        return .error(.io(.init(message: "Purchase is pending")))
      case .unknown:
        return .error(.io(.init(message: "Unknown purchase result")))
      }
    } catch {
      return .error(.io(.init(message: "Purchase failed: \(error.localizedDescription)")))
    }
  }

  /// `get_product_status {payload: {productId}}` answers `{isOwned}`: whether
  /// a verified transaction entitles the user to the product now.
  private static func getProductStatus(_ client: any StoreClient, _ args: Data) async
    -> StoreReply
  {
    guard let id = productId(args) else {
      return .error(.parse(.init(message: "iap get_product_status takes {payload: {productId}}")))
    }
    return .value(IapProductStatus(isOwned: await client.isEntitled(to: id)))
  }

  /// `get_environment` answers `{environment}`: `Production` for an App Store
  /// install, `Sandbox` for TestFlight and development installs, `Xcode` for
  /// a StoreKit configuration run.
  private static func getEnvironment(_ client: any StoreClient) async -> StoreReply {
    guard let environment = await client.environment() else {
      return .error(.io(.init(message: "the app transaction is unavailable")))
    }
    return .value(AppStoreEnvironmentReply(environment: environment))
  }

  /// `sync` fetches transactions and subscription status from the App Store
  /// again. The system can show its sign-in prompt.
  private static func sync(_ client: any StoreClient) async -> StoreReply {
    do {
      try await client.sync()
      return .null
    } catch {
      return .error(.io(.init(message: "AppStore.sync failed: \(error.localizedDescription)")))
    }
  }
}
