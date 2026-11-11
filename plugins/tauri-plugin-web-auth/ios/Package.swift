// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "tauri-plugin-web-auth",
  // iOS only: only the iOS target registers the plugin. `.iOS(.v16)` matches
  // the app's deployment target.
  platforms: [
    .iOS(.v16)
  ],
  products: [
    .library(
      name: "tauri-plugin-web-auth",
      type: .static,
      targets: ["tauri-plugin-web-auth"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "ReflectApple", path: "../../../apple"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-web-auth",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "WebAuthKit", package: "ReflectApple"),
      ],
      path: "Sources")
  ],
  swiftLanguageModes: [.v5]
)
