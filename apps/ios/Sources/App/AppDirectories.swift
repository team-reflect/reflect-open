import Foundation
import WebKit

/// The places where the app keeps its data: the directories of the Rust core
/// and the data store of the web view.
///
/// A UI test gives each of its sessions its own places (Debug builds only).
/// It launches the app with the environment variable `REFLECT_UITEST_SESSION`
/// set to a UUID. The app then starts as an install that finished onboarding
/// with storage on this device, and keeps its graph, its settings and the
/// data of the web view inside that session. Other data of the app, such as
/// staged recordings and the keychain, stays in the app's own places.
/// A second launch with the same UUID opens the same data.
struct AppDirectories {
  /// The directory of the on-device graph.
  var documents: URL
  /// The parent of the app's data directory.
  var applicationSupport: URL
  /// The data store of the web view.
  var websiteDataStore: WKWebsiteDataStore

  @MainActor
  static func current(fileManager: FileManager = .default) throws -> AppDirectories {
    #if DEBUG
    if let name = ProcessInfo.processInfo.environment["REFLECT_UITEST_SESSION"] {
      // The data of the developer is not a fallback for a test.
      guard let session = UUID(uuidString: name) else {
        throw InvalidUITestSession(name: name)
      }
      return try uiTestSession(session, fileManager: fileManager)
    }
    #endif
    return AppDirectories(
      documents: try fileManager.url(
        for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true),
      applicationSupport: try fileManager.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true),
      websiteDataStore: .default())
  }

  #if DEBUG
  /// The places of one UI test session, under `tmp/uitest/<UUID>`.
  @MainActor
  private static func uiTestSession(_ session: UUID, fileManager: FileManager) throws
    -> AppDirectories
  {
    let sessions = fileManager.temporaryDirectory.appendingPathComponent("uitest")
    let home = sessions.appendingPathComponent(session.uuidString)
    let documents = home.appendingPathComponent("Documents")
    let applicationSupport = home.appendingPathComponent("Library/Application Support")
    for directory in [documents, applicationSupport] {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // The data of earlier sessions has no more use. WebKit lists its data
    // stores only after it made one.
    let websiteDataStore = WKWebsiteDataStore(forIdentifier: session)
    for other in (try? fileManager.contentsOfDirectory(atPath: sessions.path)) ?? []
    where other != session.uuidString {
      try? fileManager.removeItem(at: sessions.appendingPathComponent(other))
    }
    WKWebsiteDataStore.fetchAllDataStoreIdentifiers { identifiers in
      for identifier in identifiers where identifier != session {
        WKWebsiteDataStore.remove(forIdentifier: identifier) { _ in }
      }
    }

    // The Rust core keeps its settings and its list of recent graphs in
    // `$HOME/Library/Application Support/reflect-open`.
    setenv("HOME", home.path, 1)
    let settings = applicationSupport.appendingPathComponent("reflect-open/settings.json")
    if !fileManager.fileExists(atPath: settings.path) {
      try fileManager.createDirectory(
        at: settings.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(#"{"mobileOnboarded":true,"mobileStorage":"local"}"#.utf8).write(to: settings)
    }

    return AppDirectories(
      documents: documents, applicationSupport: applicationSupport,
      websiteDataStore: websiteDataStore)
  }
  #endif
}

#if DEBUG
/// `REFLECT_UITEST_SESSION` has a value that is not a UUID.
struct InvalidUITestSession: Error, CustomStringConvertible {
  var name: String

  var description: String {
    "REFLECT_UITEST_SESSION must be a UUID, but it is \"\(name)\""
  }
}
#endif
