import StoreKit

/// The `StoreClient` on StoreKit 2. Each function is one StoreKit call and
/// the conversion of its result.
public struct LiveStoreClient: StoreClient {
  public init() {}

  public func products(for ids: [String]) async throws -> [StoreProduct] {
    try await Product.products(for: ids).map {
      StoreProduct(id: $0.id, displayPrice: $0.displayPrice)
    }
  }

  public func purchase(_ id: String) async throws -> PurchaseOutcome? {
    guard let product = try await Product.products(for: [id]).first else { return nil }
    switch try await product.purchase() {
    case .success(.verified(let transaction)):
      await transaction.finish()
      return .purchased
    case .success(.unverified):
      return .unverified
    case .userCancelled:
      return .cancelled
    case .pending:
      return .pending
    @unknown default:
      return .unknown
    }
  }

  public func isEntitled(to id: String) async -> Bool {
    guard case .verified = await Transaction.currentEntitlement(for: id) else { return false }
    return true
  }

  public func environment() async -> String? {
    await AppStoreEnvironment.current()
  }

  public func sync() async throws {
    try await AppStore.sync()
  }

  public func updates() -> AsyncStream<StoreUpdate> {
    AsyncStream { continuation in
      let listener = Task {
        for await update in Transaction.updates {
          guard case .verified(let transaction) = update else { continue }
          continuation.yield(StoreUpdate { await transaction.finish() })
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in listener.cancel() }
    }
  }
}
