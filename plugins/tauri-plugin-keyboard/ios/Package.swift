// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "tauri-plugin-keyboard",
  // iOS only: the keyboard tuning (`KeyboardKit` in the repo's `apple/`
  // package) uses UIKit/WebKit, and only the iOS target registers the plugin
  // (desktop builds do not compile this crate at all; see `src/desktop.rs`).
  // iOS 15 matches the `apple/` package.
  platforms: [
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-keyboard",
      type: .static,
      targets: ["tauri-plugin-keyboard"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "ReflectApple", path: "../../../apple"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-keyboard",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "KeyboardKit", package: "ReflectApple"),
      ],
      path: "Sources")
  ],
  swiftLanguageModes: [.v5]
)
