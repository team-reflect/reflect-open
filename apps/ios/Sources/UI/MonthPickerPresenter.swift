import UIKit

/// The month wheel of the Daily title, in a popover on every device. It
/// reports the month when the popover closes, if the month changed.
@MainActor
final class MonthPickerPresenter: NSObject, UIPopoverPresentationControllerDelegate {
  var onPick: (String) -> Void = { _ in }

  private var start: String?
  private weak var picker: UIDatePicker?

  private static let calendar = Calendar(identifier: .gregorian)

  func present(month: String, from source: UIView, in presenter: UIViewController) {
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
    self.picker = picker
    presenter.present(controller, animated: true)
  }

  /// A popover on iPhone too, as the web view's month input showed.
  func adaptivePresentationStyle(
    for controller: UIPresentationController, traitCollection: UITraitCollection
  ) -> UIModalPresentationStyle { .none }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard let picker, let month = Self.month(picker.date), month != start else { return }
    onPick(month)
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
