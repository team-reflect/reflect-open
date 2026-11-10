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
  // swift-rs builds the plugins, and these modules with them, with the
  // triple `arm64-apple-ios15.0-simulator` (`-ios15.0` on device): the
  // objects get `minos 15.0` whatever floor a manifest declares.
  platforms: [.iOS(.v15), .macOS(.v13)],
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
