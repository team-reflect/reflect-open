import UIKit

/// The month wheel of the Daily title, in a popover on every device. It
/// reports the month and the entry it opened for when the user closes the
/// popover, if the month changed.
@MainActor
final class MonthPickerPresenter: NSObject, UIPopoverPresentationControllerDelegate {
  var onPick: (_ month: String, _ entryId: Int) -> Void = { _, _ in }

  private var start: String?
  private var entryId: Int?
  private weak var picker: UIDatePicker?
  private weak var controller: UIViewController?

  private static let calendar = Calendar(identifier: .gregorian)

  func present(
    month: String, entryId: Int, from source: UIView, in presenter: UIViewController
  ) {
    let picker = UIDatePicker()
    picker.datePickerMode = .yearAndMonth
    picker.preferredDatePickerStyle = .wheels
    picker.date = Self.date(month) ?? .now
    let controller = UIViewController()
    controller.view = picker
    controller.preferredContentSize = picker.systemLayoutSizeFitting(
      UIView.layoutFittingCompressedSize)
    controller.modalPresentationStyle = .popover
    controller.popoverPresentationController?.sourceItem = source
    controller.popoverPresentationController?.delegate = self
    start = month
    self.entryId = entryId
    self.picker = picker
    self.controller = controller
    presenter.present(controller, animated: true)
  }

  /// A popover on iPhone too, as the web view's month input showed.
  func adaptivePresentationStyle(
    for controller: UIPresentationController, traitCollection: UITraitCollection
  ) -> UIModalPresentationStyle { .none }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard let picker, let entryId, let month = Self.month(picker.date), month != start
    else { return }
    onPick(month, entryId)
  }

  /// Closes the popover without a pick, unless it shows the picker of
  /// `entryId`.
  func close(keeping entryId: Int? = nil) {
    guard let controller, self.entryId != entryId else { return }
    controller.dismiss(animated: true)
    self.controller = nil
  }

  static func date(_ month: String) -> Date? {
    let parts = month.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 2 else { return nil }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
  }

  static func month(_ date: Date) -> String? {
    let parts = calendar.dateComponents([.year, .month], from: date)
    guard let year = parts.year, let month = parts.month else { return nil }
    return String(format: "%04d-%02d", year, month)
  }
}
