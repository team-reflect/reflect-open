// swift-tools-version:5.7

import PackageDescription

let package = Package(
    name: "tauri-plugin-web-auth",
    // iOS only: only the iOS target registers the plugin. `.iOS(.v16)` matches
    // the app's deployment target; tools 5.7 is the floor for it.
    platforms: [
        .iOS(.v16),
    ],
    products: [
        .library(
            name: "tauri-plugin-web-auth",
            type: .static,
            targets: ["tauri-plugin-web-auth"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-web-auth",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
