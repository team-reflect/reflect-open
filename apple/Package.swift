// swift-tools-version: 6.2
import PackageDescription

// The Swift code that the iOS app and its extensions share.

// MARK: - Layer rules (checked when SwiftPM loads this manifest)

enum Layer {
  /// Data types and small helpers shared across processes.
  case shared
  /// Platform logic driven by a host: a capability of the Swift shell.
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
  Module(name: "AppStoreKit", layer: .engine, hasTests: true),
  Module(name: "CaptureShared", layer: .shared, hasTests: true),
  Module(name: "KeyboardKit", layer: .engine),
  Module(name: "RecordingShared", layer: .shared),
  Module(name: "RecordingKit", layer: .engine, deps: ["RecordingShared"], hasTests: true),
  Module(name: "WebAuthKit", layer: .engine),
  Module(name: "WebHostKit", layer: .engine, hasTests: true),
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
  .treatAllWarnings(as: .error),
]

let package = Package(
  name: "ReflectApple",
  platforms: [.iOS(.v18), .macOS(.v13)],
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
