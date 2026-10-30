// swift-tools-version:5.3

import PackageDescription

let package = Package(
    name: "tauri-plugin-native-menu",
    // iOS only: NativeMenuPlugin.swift imports UIKit unconditionally, and only
    // the iOS target registers the plugin (desktop builds do not compile this
    // crate at all; see `src/desktop.rs`). Context menus (iOS 16+) and the
    // menu bar (iPadOS 26+) are availability-checked at runtime.
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-native-menu",
            type: .static,
            targets: ["tauri-plugin-native-menu"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-native-menu",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
