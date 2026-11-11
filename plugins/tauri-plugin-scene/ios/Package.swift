// swift-tools-version:5.3

import PackageDescription

let package = Package(
    name: "tauri-plugin-scene",
    // iOS only: ScenePlugin.swift imports UIKit unconditionally, and only the
    // iOS target registers the plugin (desktop builds do not compile this
    // crate at all; see `src/desktop.rs`).
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-scene",
            type: .static,
            targets: ["tauri-plugin-scene"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-scene",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
