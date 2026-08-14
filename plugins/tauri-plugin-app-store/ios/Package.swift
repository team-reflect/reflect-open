// swift-tools-version:5.7
// The swift-tools-version declares the minimum version of Swift required to
// build this package (5.7 is the floor for `.iOS(.v16)` below).

import PackageDescription

let package = Package(
    name: "tauri-plugin-app-store",
    // iOS only: AppStorePlugin.swift uses StoreKit 2's `AppTransaction`
    // (iOS 16+), and the plugin is registered only on the iOS target. The
    // macOS entry mirrors AppTransaction's macOS floor but is never built.
    platforms: [
        .macOS(.v13),
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
