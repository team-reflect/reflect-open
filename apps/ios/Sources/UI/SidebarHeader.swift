import UIKit

/// The top of the iPad sidebar: the Search button at the trailing edge.
struct SidebarHeader: UIContentConfiguration {
  var onSearch: () -> Void

  func makeContentView() -> any UIView & UIContentView {
    SidebarHeaderView(configuration: self)
  }

  func updated(for state: any UIConfigurationState) -> SidebarHeader {
    self
  }
}

/// The view of `SidebarHeader`.
@MainActor
private final class SidebarHeaderView: UIView, UIContentView {
  var configuration: any UIContentConfiguration {
    didSet { header = configuration as? SidebarHeader ?? header }
  }

  private var header: SidebarHeader
  private let searchButton = UIButton(configuration: .plain())

  init(configuration: SidebarHeader) {
    self.configuration = configuration
    header = configuration
    super.init(frame: .zero)
    searchButton.configuration?.image = UIImage(systemName: "magnifyingglass")
    searchButton.accessibilityLabel = "Search"
    searchButton.tintColor = .secondaryLabel
    searchButton.addAction(
      UIAction { [weak self] _ in self?.header.onSearch() }, for: .primaryActionTriggered)
    searchButton.translatesAutoresizingMaskIntoConstraints = false
    addSubview(searchButton)
    // The trailing edge of the rows, so the button lines up with the sidebar
    // toggle and the chevron of Pinned notes.
    NSLayoutConstraint.activate([
      searchButton.trailingAnchor.constraint(equalTo: trailingAnchor),
      searchButton.topAnchor.constraint(equalTo: topAnchor),
      searchButton.bottomAnchor.constraint(equalTo: bottomAnchor),
      searchButton.widthAnchor.constraint(equalToConstant: 44),
      searchButton.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }
}
