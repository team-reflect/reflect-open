// swift-tools-version:5.3

import PackageDescription

let package = Package(
    name: "tauri-plugin-recording",
    // iOS only: RecordingPlugin.swift imports UIKit/AVFoundation
    // unconditionally, and only the iOS target registers the plugin
    // (desktop builds do not compile this crate at all; see
    // `src/desktop.rs`).
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-recording",
            type: .static,
            targets: ["tauri-plugin-recording"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-recording",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
