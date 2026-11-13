import AppStoreKit
import StoreKit
import TypesShared
import UIKit
import WebHostKit

/// The `plugin:iap` and `plugin:app-store` commands: subscriptions and the
/// App Store sheets, on StoreKit 2. `StoreCommands` holds the commands that
/// need no window; this class adds the two sheets.
@MainActor
final class StoreCapability {
  private let scene: () -> UIWindowScene?
  private let store: StoreCommands

  /// `scene` returns the window scene that presents the App Store sheets.
  /// `emit` delivers `plugin:iap:purchaseUpdated` for each transaction that
  /// arrives outside a purchase: a renewal, a redeemed code, a restore.
  init(
    scene: @escaping () -> UIWindowScene?,
    client: any StoreClient = LiveStoreClient(),
    emit: @escaping @MainActor (String, Data) -> Void
  ) {
    self.scene = scene
    store = StoreCommands(client: client, emit: emit)
  }

  /// Starts to listen for transactions that arrive outside a purchase. Call
  /// it once, when the app starts.
  func start() {
    store.start()
  }

  var commands: [String: ShellCommand] {
    var commands: [String: ShellCommand] = [
      "plugin:app-store|present_offer_code_redeem_sheet": { [self] _ in await redeemOfferCode() },
      "plugin:app-store|request_review": { [self] _ in requestReview() },
    ]
    for (name, command) in store.commands {
      commands[name] = { request in CoreReply(await command(request.args)) }
    }
    return commands
  }

  /// `present_offer_code_redeem_sheet` shows the offer code sheet. A redeemed
  /// code arrives as a `purchaseUpdated` event.
  private func redeemOfferCode() async -> CoreReply {
    guard let scene = scene() else {
      return .error(.io(.init(message: "no active window scene")))
    }
    do {
      try await AppStore.presentOfferCodeRedeemSheet(in: scene)
      return .null
    } catch {
      return .error(
        .io(.init(message: "presentOfferCodeRedeemSheet failed: \(error.localizedDescription)")))
    }
  }

  /// `request_review` asks StoreKit for its review prompt. The system decides
  /// whether to show it.
  private func requestReview() -> CoreReply {
    guard let scene = scene() else {
      return .error(.io(.init(message: "no active window scene")))
    }
    AppStore.requestReview(in: scene)
    return .null
  }
}

extension CoreReply {
  /// The reply of a store command in the shape that the page receives.
  fileprivate init(_ reply: StoreReply) {
    switch reply {
    case .json(let json): self = .json(json)
    case .null: self = .null
    case .error(let error): self = .error(error)
    }
  }
}
