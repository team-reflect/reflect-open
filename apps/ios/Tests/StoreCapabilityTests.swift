import StoreKitTest
import WebHostKit
import XCTest

@testable import Reflect

@MainActor
final class StoreCapabilityTests: XCTestCase {
  private let monthly = "app.reflect.ios.pro.monthly"
  private var session: SKTestSession!
  private var updated = 0
  private var store: StoreCapability!

  override func setUp() async throws {
    session = try SKTestSession(configurationFileNamed: "reflect-open-storekit")
    session.resetToDefaultState()
    session.disableDialogs = true
    session.clearTransactions()
    updated = 0
    store = StoreCapability(
      scene: { nil },
      emit: { [unowned self] name, _ in
        if name == "plugin:iap:purchaseUpdated" { updated += 1 }
      })
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
    for _ in 0..<600 where updated == 0 {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertGreaterThan(updated, 0)
    let owned = try await isOwned()
    XCTAssertTrue(owned)
  }
}
