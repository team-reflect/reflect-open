// swift-tools-version:5.3

import PackageDescription

let package = Package(
    name: "tauri-plugin-keyboard",
    // iOS only: KeyboardPlugin.swift imports UIKit/WebKit unconditionally,
    // and only the iOS target registers the plugin (desktop builds do not
    // compile this crate at all; see `src/desktop.rs`).
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-keyboard",
            type: .static,
            targets: ["tauri-plugin-keyboard"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-keyboard",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
