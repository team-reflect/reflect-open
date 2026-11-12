/// One product of the store: its identifier and its localized price.
public struct StoreProduct: Sendable, Equatable {
  public var id: String
  public var displayPrice: String

  public init(id: String, displayPrice: String) {
    self.id = id
    self.displayPrice = displayPrice
  }
}

/// The result of one purchase.
public enum PurchaseOutcome: Sendable, Equatable {
  /// The store verified the transaction, and the client finished it.
  case purchased
  /// The store did not verify the transaction.
  case unverified
  case cancelled
  case pending
  /// A result that this version of the app does not know.
  case unknown
}

/// One verified transaction that arrived outside a purchase: a renewal, a
/// redeemed code, a restore.
public struct StoreUpdate: Sendable {
  /// Tells the store that the app handled the transaction.
  public var finish: @Sendable () async -> Void

  public init(finish: @escaping @Sendable () async -> Void) {
    self.finish = finish
  }
}

/// The operations of the App Store that `StoreCommands` uses.
/// `LiveStoreClient` runs them on StoreKit.
public protocol StoreClient: Sendable {
  /// The products with these identifiers. Unknown identifiers are left out.
  func products(for ids: [String]) async throws -> [StoreProduct]
  /// Runs the purchase sheet for a product. Returns nil when the store has no
  /// product with this identifier.
  func purchase(_ id: String) async throws -> PurchaseOutcome?
  /// Whether a verified transaction entitles the user to the product now.
  func isEntitled(to id: String) async -> Bool
  /// The environment of this install: `Production`, `Sandbox` or `Xcode`. Nil
  /// when the store cannot tell.
  func environment() async -> String?
  /// Fetches transactions and subscription status from the App Store again.
  func sync() async throws
  /// The verified transactions that arrive outside a purchase. The stream
  /// starts to listen when this function returns.
  func updates() -> AsyncStream<StoreUpdate>
}
