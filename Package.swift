// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SyncEngine",
    platforms: [.iOS("27.0"), .macOS("26.0")],
    products: [.library(name: "SyncEngine", targets: ["SyncEngine"])],
    dependencies: [.package(url: "https://github.com/groue/GRDB.swift.git", from: "7.11.1")],
    targets: [
        .target(name: "SyncEngine", dependencies: [.product(name: "GRDB", package: "GRDB.swift")]),
        .testTarget(name: "SyncEngineTests", dependencies: ["SyncEngine"]),
    ]
)
