import Foundation
import Sentry

/// Native crash/hang reporting for the iOS host process.
///
/// The JavaScript layer already reports webview exceptions
/// (`apps/desktop/src/lib/exception-telemetry.ts`), but a Rust panic, a Swift
/// crash, an OS watchdog kill, or a WebKit content-process death never reaches
/// it. Those are exactly the terminations that arrive in TestFlight without a
/// usable report, so the host starts Sentry Cocoa purely to capture the native
/// stacks. Everything that could carry note content — messages, breadcrumbs,
/// file paths, source context, PII — is disabled or scrubbed here; see
/// `docs/privacy.md`.
private enum NativeDiagnostics {
  /// The production Reflect project. Sentry DSNs authorize event submission
  /// only and are safe to embed in the binary; leaving this empty (as forks
  /// do) disables the reporter entirely.
  /// https://docs.sentry.io/concepts/key-terms/dsn-explainer/
  private static let dsn = ""

  /// Forks build under their own bundle identifier and stay silent even if
  /// they carry a DSN.
  private static let officialBundleIdentifier = "app.reflect.ios"

  private static let redacted = "[redacted]"

  /// Device/OS/app context fields that cannot describe a user's notes.
  private static let safeContextFields: [String: Set<String>] = [
    "app": [
      "app_identifier",
      "app_name",
      "app_version",
      "app_build",
      "app_start_time",
      "in_foreground",
    ],
    "device": [
      "family",
      "model",
      "model_id",
      "arch",
      "memory_size",
      "free_memory",
      "usable_memory",
      "storage_size",
      "free_storage",
      "simulator",
      "thermal_state",
      "orientation",
      "charging",
      "battery_level",
      "online",
      "processor_count",
    ],
    "os": [
      "name",
      "version",
      "build",
      "kernel_version",
      "rooted",
    ],
  ]

  static func start() {
    guard !dsn.isEmpty, Bundle.main.bundleIdentifier == officialBundleIdentifier else {
      return
    }

    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let build = info?["CFBundleVersion"] as? String

    SentrySDK.start { options in
      options.dsn = dsn
      // Matches the release name the webview SDK reports, so native and
      // JavaScript events for one build group together. Tauri strips
      // prerelease tags when it writes CFBundleShortVersionString, so beta
      // builds report `reflect@x.y.z` while the webview reports the full
      // package version.
      options.releaseName = "reflect@\(version)"
      options.dist = build
      options.environment = "production"
      options.debug = false
      options.sampleRate = 1
      options.tracesSampleRate = 0

      options.sendDefaultPii = false
      options.sendClientReports = false
      options.enableAutoSessionTracking = false
      options.maxBreadcrumbs = 0
      options.beforeBreadcrumb = { _ in nil }

      // The stack-bearing terminations this integration exists for.
      options.enableCrashHandler = true
      options.enableAppHangTracking = true
      options.enableAppHangTrackingV2 = true
      options.enableReportNonFullyBlockingAppHangs = false
      options.appHangTimeoutInterval = 2
      options.enableWatchdogTerminationTracking = true
      options.enableSigtermReporting = false

      // Everything else the SDK would collect by default.
      options.attachScreenshot = false
      options.attachViewHierarchy = false
      options.enableAutoBreadcrumbTracking = false
      options.enableNetworkBreadcrumbs = false
      options.enableCaptureFailedRequests = false
      options.enableAutoPerformanceTracing = false
      options.enableUIViewControllerTracing = false
      options.enableUserInteractionTracing = false
      options.enableNetworkTracking = false
      options.enableFileIOTracing = false
      options.enableCoreDataTracing = false

      options.enableMetricKit = true
      options.enableMetricKitRawPayload = false

      options.beforeSend = { event in
        scrub(event: event)
      }
    }
  }

  /// Drop anything without a stack, then strip every field that is not an
  /// address, a symbol, or allow-listed device metadata.
  private static func scrub(event: Event) -> Event? {
    let hasDiagnosticStack =
      event.stacktrace != nil || event.exceptions?.isEmpty == false || event.threads?.isEmpty == false
    guard hasDiagnosticStack else {
      return nil
    }

    event.message = nil
    event.error = nil
    event.logger = nil
    event.serverName = nil
    event.transaction = nil
    event.user = nil
    event.request = nil
    event.extra = nil
    event.modules = nil
    event.fingerprint = nil
    event.breadcrumbs = []
    event.tags = ["runtime": "tauri-native"]
    event.context = scrub(context: event.context)
    // Debug images keep their UUID and address range — that is what Sentry
    // matches the uploaded dSYMs against — but not their build-machine paths.
    event.debugMeta?.forEach { image in
      image.codeFile = image.codeFile.map(basename)
      image.name = image.name.map(basename)
    }

    event.exceptions?.forEach { exception in
      exception.value = redacted
      exception.type = "NativeCrash"
      exception.module = nil
      exception.mechanism?.type = "native"
      exception.mechanism?.desc = nil
      exception.mechanism?.data = nil
      exception.mechanism?.helpLink = nil
      scrub(stacktrace: exception.stacktrace)
    }
    event.threads?.forEach { thread in
      thread.name = nil
      scrub(stacktrace: thread.stacktrace)
    }
    scrub(stacktrace: event.stacktrace)
    return event
  }

  private static func scrub(context: [String: [String: Any]]?) -> [String: [String: Any]]? {
    guard let context else {
      return nil
    }
    var scrubbed: [String: [String: Any]] = [:]
    for (name, allowedFields) in safeContextFields {
      guard let values = context[name] else {
        continue
      }
      let allowedValues = values.filter { allowedFields.contains($0.key) }
      if !allowedValues.isEmpty {
        scrubbed[name] = allowedValues
      }
    }
    return scrubbed.isEmpty ? nil : scrubbed
  }

  private static func scrub(stacktrace: SentryStacktrace?) {
    stacktrace?.frames.forEach { frame in
      frame.fileName = nil
      frame.contextLine = nil
      frame.preContext = nil
      frame.postContext = nil
      frame.vars = nil
      if let package = frame.package {
        frame.package = package.split(separator: "/").last.map(String.init)
      }
    }
  }

  private static func basename(_ path: String) -> String {
    (path as NSString).lastPathComponent
  }
}

/// Called once from `main.mm` before Tauri boots, so crashes during Tauri
/// initialization are already covered.
@_cdecl("reflect_start_native_diagnostics")
public func reflectStartNativeDiagnostics() {
  #if !DEBUG
    NativeDiagnostics.start()
  #endif
}
