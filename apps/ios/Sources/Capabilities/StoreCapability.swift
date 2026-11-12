import AppStoreKit
import StoreKit
import UIKit
import WebHostKit

/// The `plugin:iap` and `plugin:app-store` commands: subscriptions and the
/// App Store sheets, on StoreKit 2.
@MainActor
final class StoreCapability {
  private let scene: () -> UIWindowScene?
  private var updates: Task<Void, Never>?

  /// `scene` returns the window scene that presents the App Store sheets.
  /// `emit` delivers `plugin:iap:purchaseUpdated` for each transaction that
  /// arrives outside a purchase: a renewal, a redeemed code, a restore.
  init(scene: @escaping () -> UIWindowScene?, emit: @escaping @MainActor (String, Data) -> Void) {
    self.scene = scene
    updates = Task {
      for await update in Transaction.updates {
        guard case .verified(let transaction) = update else { continue }
        emit("plugin:iap:purchaseUpdated", Data())
        await transaction.finish()
      }
    }
  }

  deinit {
    updates?.cancel()
  }

  var commands: [String: ShellCommand] {
    [
      "plugin:iap|get_products": { [self] request in await getProducts(request) },
      "plugin:iap|purchase": { [self] request in await purchase(request) },
      "plugin:iap|get_product_status": { [self] request in await getProductStatus(request) },
      "plugin:app-store|get_environment": { [self] _ in await getEnvironment() },
      "plugin:app-store|sync": { [self] _ in await sync() },
      "plugin:app-store|present_offer_code_redeem_sheet": { [self] _ in await redeemOfferCode() },
      "plugin:app-store|request_review": { [self] _ in requestReview() },
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

  /// `get_products {payload: {productIds}}` answers `{products: [{productId, formattedPrice}]}`.
  private func getProducts(_ request: ShellRequest) async -> CoreReply {
    struct Response: Encodable {
      struct Item: Encodable {
        var productId: String
        var formattedPrice: String
      }
      var products: [Item]
    }
    guard let ids = request.decodeArgs(IAPArgs.self)?.payload.productIds else {
      return .error(kind: "parse", message: "iap get_products takes {payload: {productIds}}")
    }
    do {
      let products = try await Product.products(for: ids)
      return .value(
        Response(
          products: products.map { .init(productId: $0.id, formattedPrice: $0.displayPrice) }))
    } catch {
      return .error(kind: "io", message: "Failed to fetch products: \(error.localizedDescription)")
    }
  }

  /// `purchase {payload: {productId}}` runs the purchase sheet. It answers
  /// `null` for a verified purchase and an error for any other outcome.
  private func purchase(_ request: ShellRequest) async -> CoreReply {
    guard let id = request.decodeArgs(IAPArgs.self)?.payload.productId else {
      return .error(kind: "parse", message: "iap purchase takes {payload: {productId}}")
    }
    do {
      guard let product = try await Product.products(for: [id]).first else {
        return .error(kind: "notFound", message: "Product not found")
      }
      switch try await product.purchase() {
      case .success(.verified(let transaction)):
        await transaction.finish()
        return .null
      case .success(.unverified):
        return .error(kind: "io", message: "Transaction verification failed")
      case .userCancelled:
        return .error(kind: "io", message: "Purchase cancelled by user")
      case .pending:
        return .error(kind: "io", message: "Purchase is pending")
      @unknown default:
        return .error(kind: "io", message: "Unknown purchase result")
      }
    } catch {
      return .error(kind: "io", message: "Purchase failed: \(error.localizedDescription)")
    }
  }

  /// `get_product_status {payload: {productId}}` answers `{isOwned}`: whether
  /// a verified transaction entitles the user to the product now.
  private func getProductStatus(_ request: ShellRequest) async -> CoreReply {
    struct Response: Encodable {
      var isOwned: Bool
    }
    guard let id = request.decodeArgs(IAPArgs.self)?.payload.productId else {
      return .error(kind: "parse", message: "iap get_product_status takes {payload: {productId}}")
    }
    guard case .verified = await Transaction.currentEntitlement(for: id) else {
      return .value(Response(isOwned: false))
    }
    return .value(Response(isOwned: true))
  }

  /// `get_environment` answers `{environment}`: `Production` for an App Store
  /// install, `Sandbox` for TestFlight and development installs, `Xcode` for
  /// a StoreKit configuration run.
  private func getEnvironment() async -> CoreReply {
    struct Response: Encodable {
      var environment: String
    }
    guard let environment = await AppStoreEnvironment.current() else {
      return .error(kind: "io", message: "the app transaction is unavailable")
    }
    return .value(Response(environment: environment))
  }

  /// `sync` fetches transactions and subscription status from the App Store
  /// again. The system can show its sign-in prompt.
  private func sync() async -> CoreReply {
    do {
      try await AppStore.sync()
      return .null
    } catch {
      return .error(kind: "io", message: "AppStore.sync failed: \(error.localizedDescription)")
    }
  }

  /// `present_offer_code_redeem_sheet` shows the offer code sheet. A redeemed
  /// code arrives as a `purchaseUpdated` event.
  private func redeemOfferCode() async -> CoreReply {
    guard let scene = scene() else {
      return .error(kind: "io", message: "no active window scene")
    }
    do {
      try await AppStore.presentOfferCodeRedeemSheet(in: scene)
      return .null
    } catch {
      return .error(
        kind: "io",
        message: "presentOfferCodeRedeemSheet failed: \(error.localizedDescription)")
    }
  }

  /// `request_review` asks StoreKit for its review prompt. The system decides
  /// whether to show it.
  private func requestReview() -> CoreReply {
    guard let scene = scene() else {
      return .error(kind: "io", message: "no active window scene")
    }
    AppStore.requestReview(in: scene)
    return .null
  }
}
