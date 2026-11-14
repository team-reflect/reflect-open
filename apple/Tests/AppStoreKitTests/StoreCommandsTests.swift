import Foundation
import Testing
import TypesShared

@testable import AppStoreKit

private struct StoreFailure: Error {}

/// A `StoreClient` that answers from its properties. After `updates()`, the
/// test sends updates through `send`.
private final class FakeStoreClient: StoreClient, @unchecked Sendable {
  var catalog: [StoreProduct] = []
  var outcome: PurchaseOutcome? = .purchased
  var entitled: Set<String> = []
  var environmentName: String? = "Xcode"
  var fails = false
  /// The number of `updates()` calls.
  private(set) var listeners = 0

  private var continuation: AsyncStream<StoreUpdate>.Continuation?

  /// Sends an update to the listener. As in the live client, no update
  /// exists before `updates()`.
  func send(_ update: StoreUpdate) {
    guard let continuation else {
      Issue.record("an update was sent before updates()")
      return
    }
    continuation.yield(update)
  }

  func products(for ids: [String]) async throws -> [StoreProduct] {
    if fails { throw StoreFailure() }
    return catalog.filter { ids.contains($0.id) }
  }

  func purchase(_ id: String) async throws -> PurchaseOutcome? {
    if fails { throw StoreFailure() }
    return outcome
  }

  func isEntitled(to id: String) async -> Bool {
    entitled.contains(id)
  }

  func environment() async -> String? {
    environmentName
  }

  func sync() async throws {
    if fails { throw StoreFailure() }
  }

  func updates() -> AsyncStream<StoreUpdate> {
    listeners += 1
    let (stream, continuation) = AsyncStream.makeStream(of: StoreUpdate.self)
    self.continuation = continuation
    return stream
  }
}

/// The names of the things that happened, in order.
@MainActor
private final class EventLog {
  var entries: [String] = []
}

@MainActor
private func run(
  _ command: String, _ args: String = "{}", on client: FakeStoreClient
) async throws -> StoreReply {
  let commands = StoreCommands(client: client, emit: { _, _ in })
  let handler = try #require(commands.commands[command])
  return await handler(Data(args.utf8))
}

private func jsonObject(_ reply: StoreReply) throws -> NSObject {
  guard case .json(let json) = reply else {
    Issue.record("the reply is \(reply)")
    return NSNull()
  }
  return try #require(
    JSONSerialization.jsonObject(with: json, options: .fragmentsAllowed) as? NSObject)
}

private func isError(_ reply: StoreReply, kind: String, messagePrefix: String) -> Bool {
  guard case .error(let error) = reply,
    let wire = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(error))
      as? [String: String]
  else { return false }
  return wire["kind"] == kind && wire["message"]?.hasPrefix(messagePrefix) == true
}

@MainActor
@Test func getProductsAnswersTheIDsAndPricesOfTheKnownProducts() async throws {
  let client = FakeStoreClient()
  client.catalog = [
    StoreProduct(id: "monthly", displayPrice: "$4.99"),
    StoreProduct(id: "yearly", displayPrice: "$49.99"),
    StoreProduct(id: "other", displayPrice: "$1.00"),
  ]
  let reply = try await run(
    "plugin:iap|get_products",
    #"{"payload":{"productIds":["monthly","yearly","missing"],"productType":"subs"}}"#,
    on: client)
  let expected: NSDictionary = [
    "products": [
      ["productId": "monthly", "formattedPrice": "$4.99"],
      ["productId": "yearly", "formattedPrice": "$49.99"],
    ]
  ]
  #expect(try jsonObject(reply) == expected)
}

@MainActor
@Test(arguments: [
  ("plugin:iap|get_products", "iap get_products takes"),
  ("plugin:iap|purchase", "iap purchase takes"),
  ("plugin:iap|get_product_status", "iap get_product_status takes"),
])
func aCommandWithoutItsArgumentAnswersAParseError(command: String, message: String) async throws {
  for args in ["{}", #"{"payload":{}}"#, "not json"] {
    let reply = try await run(command, args, on: FakeStoreClient())
    #expect(isError(reply, kind: "parse", messagePrefix: message), "\(args) answered \(reply)")
  }
}

@MainActor
@Test(arguments: [
  (PurchaseOutcome.purchased, StoreReply.null),
  (.unverified, .error(.io(.init(message: "Transaction verification failed")))),
  (.cancelled, .error(.io(.init(message: "Purchase cancelled by user")))),
  (.pending, .error(.io(.init(message: "Purchase is pending")))),
  (.unknown, .error(.io(.init(message: "Unknown purchase result")))),
])
func purchaseAnswersNullOnlyForAVerifiedPurchase(
  outcome: PurchaseOutcome, expected: StoreReply
) async throws {
  let client = FakeStoreClient()
  client.outcome = outcome
  let reply = try await run(
    "plugin:iap|purchase", #"{"payload":{"productId":"monthly","productType":"subs"}}"#,
    on: client)
  #expect(reply == expected)
}

@MainActor
@Test func purchaseOfAnUnknownProductAnswersNotFound() async throws {
  let client = FakeStoreClient()
  client.outcome = nil
  let reply = try await run(
    "plugin:iap|purchase", #"{"payload":{"productId":"missing","productType":"subs"}}"#, on: client)
  #expect(reply == .error(.notFound(.init(message: "Product not found"))))
}

@MainActor
@Test(arguments: [
  (
    "plugin:iap|get_products", #"{"payload":{"productIds":["monthly"],"productType":"subs"}}"#,
    "Failed to fetch"
  ),
  (
    "plugin:iap|purchase", #"{"payload":{"productId":"monthly","productType":"subs"}}"#,
    "Purchase failed"
  ),
  ("plugin:app-store|sync", "{}", "AppStore.sync failed"),
])
func aStoreFailureAnswersAnIOError(command: String, args: String, message: String) async throws {
  let client = FakeStoreClient()
  client.fails = true
  let reply = try await run(command, args, on: client)
  #expect(isError(reply, kind: "io", messagePrefix: message), "answered \(reply)")
}

@MainActor
@Test(arguments: [true, false])
func getProductStatusAnswersWhetherTheUserOwnsTheProduct(owned: Bool) async throws {
  let client = FakeStoreClient()
  client.entitled = owned ? ["monthly"] : ["yearly"]
  let reply = try await run(
    "plugin:iap|get_product_status",
    #"{"payload":{"productId":"monthly","productType":"subs"}}"#, on: client)
  #expect(try jsonObject(reply) == ["isOwned": owned] as NSDictionary)
}

@MainActor
@Test func getEnvironmentAnswersTheEnvironmentOrAnError() async throws {
  let client = FakeStoreClient()
  let reply = try await run("plugin:app-store|get_environment", on: client)
  #expect(try jsonObject(reply) == ["environment": "Xcode"] as NSDictionary)

  client.environmentName = nil
  let failure = try await run("plugin:app-store|get_environment", on: client)
  #expect(failure == .error(.io(.init(message: "the app transaction is unavailable"))))
}

@MainActor
@Test func syncAnswersNull() async throws {
  #expect(try await run("plugin:app-store|sync", on: FakeStoreClient()) == .null)
}

@MainActor
@Test func anUpdateIsEmittedAndThenFinished() async {
  let client = FakeStoreClient()
  let log = EventLog()
  let commands = StoreCommands(
    client: client,
    emit: { name, payload in log.entries.append("emit \(name) \(payload.count)") })
  commands.start()

  for _ in 0..<2 {
    await withCheckedContinuation { finished in
      client.send(
        StoreUpdate {
          await MainActor.run { log.entries.append("finish") }
          finished.resume()
        })
    }
  }

  let emitted = "emit plugin:iap:purchaseUpdated 0"
  #expect(log.entries == [emitted, "finish", emitted, "finish"])
}

@MainActor
@Test func aSecondStartAddsNoListener() {
  let client = FakeStoreClient()
  let commands = StoreCommands(client: client, emit: { _, _ in })
  commands.start()
  commands.start()
  #expect(client.listeners == 1)
}
