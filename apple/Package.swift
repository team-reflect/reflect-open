// swift-tools-version: 6.2
import PackageDescription

// MARK: - Layer rules (checked when SwiftPM loads this manifest)

enum Layer {
  /// Data types and small helpers shared across processes.
  case shared
  /// Platform logic driven by a host (a Tauri plugin today).
  case engine

  /// Every module name ends with its layer's suffix.
  var suffix: String {
    switch self {
    case .shared: "Shared"
    case .engine: "Kit"
    }
  }

  var allowed: Set<Layer> {
    switch self {
    case .shared: []
    case .engine: [.shared]
    }
  }
}

struct Module {
  let name: String
  let layer: Layer
  var deps: [String] = []
  var hasTests = false
}

let modules: [Module] = [
  Module(name: "CaptureShared", layer: .shared, hasTests: true),
  Module(name: "RecordingShared", layer: .shared),
  Module(name: "RecordingKit", layer: .engine, deps: ["RecordingShared"], hasTests: true),
]

let layerOf = Dictionary(uniqueKeysWithValues: modules.map { ($0.name, $0.layer) })
for module in modules {
  precondition(
    module.name.hasSuffix(module.layer.suffix),
    "\(module.name) (\(module.layer)) must end with \(module.layer.suffix)")
  for dep in module.deps {
    guard let depLayer = layerOf[dep] else {
      fatalError("\(module.name) depends on unknown module \(dep)")
    }
    precondition(
      module.layer.allowed.contains(depLayer),
      "\(module.name) (\(module.layer)) may not depend on \(dep) (\(depLayer))")
  }
}

let swiftSettings: [SwiftSetting] = [
  .enableUpcomingFeature("InternalImportsByDefault"),
  .enableUpcomingFeature("MemberImportVisibility"),
]

let package = Package(
  name: "ReflectApple",
  // FIXME: [review by claude-opus-5-5]: the docs say swift-rs compiles plugins and their `apple/` modules for iOS 15, below this iOS 16
  //   floor. Please verify what actually happens: does SwiftPM accept a product with a higher minimum
  //   than the client's deployment target, or is the floor silently ignored? PR CI builds no iOS app,
  //   so please run a real `tauri ios build` (or simulator dev run) and record the result in the PR.
  //   If the effective floor is iOS 15, declaring `.iOS(.v15)` here would make the `#available` rule
  //   self-explaining instead of a doc-only trap.
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: modules.map { .library(name: $0.name, targets: [$0.name]) },
  targets:
    modules.map { module in
      .target(
        name: module.name,
        dependencies: module.deps.map { .target(name: $0) },
        swiftSettings: swiftSettings)
    }
    + modules.filter(\.hasTests).map { module in
      .testTarget(
        name: "\(module.name)Tests",
        dependencies: [.target(name: module.name)],
        swiftSettings: swiftSettings)
    },
  swiftLanguageModes: [.v5]
)
