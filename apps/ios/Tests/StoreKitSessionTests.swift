import StoreKit
import StoreKitTest
import WebHostKit
import XCTest

@testable import Reflect

/// `StoreCapability` on the real StoreKit of the simulator, with the products
/// of `reflect-open-storekit.storekit`. The logic of the commands has its own
/// tests in `apple/Tests/AppStoreKitTests`; these tests show that
/// `LiveStoreClient` connects it to StoreKit.
///
/// The Nightly test plan runs them. The Reflect test plan skips them: the
/// result depends on the StoreKit daemon of a new simulator.
@MainActor
final class StoreKitSessionTests: XCTestCase {
  private let monthly = "app.reflect.ios.pro.monthly"
  private var session: SKTestSession!
  private var updated: XCTestExpectation!
  private var store: StoreCapability!

  override func setUp() async throws {
    session = try SKTestSession(configurationFileNamed: "reflect-open-storekit")
    session.resetToDefaultState()
    session.disableDialogs = true
    session.clearTransactions()
    // XCTest does not require a wait for an expectation that the test creates itself.
    updated = XCTestExpectation(description: "plugin:iap:purchaseUpdated")
    updated.assertForOverFulfill = false
    store = StoreCapability(
      scene: { nil },
      emit: { [unowned self] name, _ in
        if name == "plugin:iap:purchaseUpdated" { updated.fulfill() }
      })
    store.start()
  }

  private func call(_ command: String, _ args: String = "{}") async throws -> [String: Any] {
    let reply = await store.commands[command]!(
      ShellRequest(args: Data(args.utf8), headers: [:], body: Data()))
    guard case .json(let json) = reply else {
      XCTFail("\(command) answered \(reply)")
      return [:]
    }
    return try JSONSerialization.jsonObject(with: json, options: .fragmentsAllowed)
      as? [String: Any] ?? [:]
  }

  private func isOwned() async throws -> Bool {
    let status = try await call(
      "plugin:iap|get_product_status",
      #"{"payload":{"productId":"\#(monthly)","productType":"subs"}}"#)
    return try XCTUnwrap(status["isOwned"] as? Bool)
  }

  /// What StoreKit knows about the transactions now, for a failure message.
  private func storeKitState() async -> String {
    var unfinished: [String] = []
    for await result in Transaction.unfinished {
      switch result {
      case .verified(let transaction): unfinished.append("verified \(transaction.productID)")
      case .unverified(let transaction, let error):
        unfinished.append("unverified \(transaction.productID): \(error)")
      }
    }
    return "the session has \(session.allTransactions().count) transactions; "
      + "unfinished transactions: \(unfinished)"
  }

  func testGetProductsAnswersIDsAndPrices() async throws {
    let reply = try await call(
      "plugin:iap|get_products",
      #"{"payload":{"productIds":["\#(monthly)","app.reflect.ios.pro.yearly"],"productType":"subs"}}"#
    )
    let products = try XCTUnwrap(reply["products"] as? [[String: String]])
    XCTAssertEqual(
      Set(products.compactMap { $0["productId"] }), [monthly, "app.reflect.ios.pro.yearly"])
    XCTAssertTrue(products.allSatisfy { $0["formattedPrice"]?.isEmpty == false })
  }

  // The purchase command needs the system's purchase sheet, which does not
  // answer in a simulator's first run. The test session buys the product.
  func testATransactionOutsideAPurchaseIsReportedAndOwned() async throws {
    _ = try await session.buyProduct(identifier: monthly)
    let result = await XCTWaiter.fulfillment(of: [updated], timeout: 60)
    if result != .completed {
      let state = await storeKitState()
      XCTFail("no purchaseUpdated event in 60 s; \(state)")
    }
    let owned = try await isOwned()
    XCTAssertTrue(owned)
  }
}
