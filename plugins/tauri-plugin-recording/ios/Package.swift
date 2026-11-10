// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "tauri-plugin-recording",
  // iOS only: the recording engine (`RecordingKit` in the repo's `apple/`
  // package) uses UIKit/AVFoundation, and only the iOS target registers the
  // plugin (desktop builds do not compile this crate at all; see
  // `src/desktop.rs`). iOS 15 matches the `apple/` package.
  platforms: [
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-recording",
      type: .static,
      targets: ["tauri-plugin-recording"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "ReflectApple", path: "../../../apple"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-recording",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "RecordingKit", package: "ReflectApple"),
      ],
      path: "Sources")
  ],
  swiftLanguageModes: [.v5]
)
