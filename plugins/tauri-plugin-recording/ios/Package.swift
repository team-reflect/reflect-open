// swift-tools-version:5.9
// FIXME: [review by claude-opus-5-5]: this 5.9 manifest depends on `apple/`, which needs tools 6.2. It works only because the
//   toolchain is new enough. Why keep the plugins at 5.9 (docs say "tools 5.9" as a rule)? If
//   there is no swift-rs constraint, bump both plugin manifests to 6.2 so one toolchain floor is
//   stated once. Please verify swift-rs builds with 6.2 before changing.

import PackageDescription

let package = Package(
  name: "tauri-plugin-recording",
  // iOS only: the recording engine (`RecordingKit` in the repo's `apple/`
  // package) uses UIKit/AVFoundation, and only the iOS target registers the
  // plugin (desktop builds do not compile this crate at all; see
  // `src/desktop.rs`). iOS 16 matches the `apple/` package.
  platforms: [
    .iOS(.v16)
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
  ]
)
