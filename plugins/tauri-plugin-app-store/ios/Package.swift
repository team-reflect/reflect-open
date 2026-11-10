// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-app-store",
  // iOS only: the StoreKit logic lives in `AppStoreKit` from the local
  // `apple/` package (iOS 16+, the same platform floor as that package), and
  // only the iOS target registers the plugin (desktop builds do not compile
  // this crate at all; see `src/desktop.rs`).
  platforms: [
    .iOS(.v16)
  ],
  products: [
    .library(
      name: "tauri-plugin-app-store",
      type: .static,
      targets: ["tauri-plugin-app-store"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "ReflectApple", path: "../../../apple"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-app-store",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "AppStoreKit", package: "ReflectApple"),
      ],
      path: "Sources")
  ]
)
