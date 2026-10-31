// swift-tools-version:5.7

import PackageDescription

let package = Package(
    name: "tauri-plugin-app-store",
    // iOS only: AppStorePlugin.swift uses StoreKit 2's `AppTransaction`
    // (iOS 16+; tools 5.7 is the floor for `.iOS(.v16)`), and only the iOS
    // target registers the plugin (desktop builds do not compile this crate
    // at all; see `src/desktop.rs`).
    platforms: [
        .iOS(.v16),
    ],
    products: [
        .library(
            name: "tauri-plugin-app-store",
            type: .static,
            targets: ["tauri-plugin-app-store"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-app-store",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
