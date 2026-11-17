import TypesShared
import XCTest

@testable import ChromeKit

final class TabFollowTests: XCTestCase {
  func testFollowsEachStateWithoutATap() {
    var follow = TabFollow()
    XCTAssertEqual(follow.state(.daily), .daily)
    XCTAssertEqual(follow.state(.all), .all)
  }

  func testHoldsATapUntilThePageShowsItsTab() {
    var follow = TabFollow()
    _ = follow.state(.daily)
    follow.tap(.tasks)
    XCTAssertNil(follow.state(.daily))
    XCTAssertEqual(follow.state(.tasks), .tasks)
    XCTAssertNil(follow.timeOut(.tasks))
    XCTAssertEqual(follow.state(.daily), .daily)
  }

  func testFollowsTheLastStateWhenATapTimesOut() {
    var follow = TabFollow()
    _ = follow.state(.daily)
    follow.tap(.tasks)
    XCTAssertNil(follow.state(.daily))
    XCTAssertEqual(follow.timeOut(.tasks), .daily)
    XCTAssertNil(follow.pendingTab)
  }

  func testIgnoresTheTimeoutOfAnEarlierTap() {
    var follow = TabFollow()
    _ = follow.state(.daily)
    follow.tap(.all)
    follow.tap(.tasks)
    XCTAssertNil(follow.timeOut(.all))
    XCTAssertEqual(follow.pendingTab, .tasks)
  }

  func testTimesOutBeforeAnyStateWithNothingToFollow() {
    var follow = TabFollow()
    follow.tap(.all)
    XCTAssertNil(follow.timeOut(.all))
    XCTAssertNil(follow.pendingTab)
  }
}
