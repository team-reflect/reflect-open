// swift-tools-version:5.3

import PackageDescription

let package = Package(
    name: "tauri-plugin-mobile-haptics",
    // iOS only: MobileHapticsPlugin.swift imports UIKit unconditionally, and
    // only the iOS target registers the plugin (desktop builds do not compile
    // this crate at all; see `src/desktop.rs`).
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-mobile-haptics",
            type: .static,
            targets: ["tauri-plugin-mobile-haptics"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-mobile-haptics",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
