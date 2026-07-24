import Foundation
import Sentry

private enum NativeDiagnostics {
    private static var started = false
    private static let redacted = "[redacted]"
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

    static func start(dsn: String, version: String) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async {
                start(dsn: dsn, version: version)
            }
            return
        }
        guard !started else {
            return
        }
        started = true

        let info = Bundle.main.infoDictionary ?? [:]
        let build = info["CFBundleVersion"] as? String

        SentrySDK.start { options in
            options.dsn = dsn
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

            options.enableCrashHandler = true
            options.enableSigtermReporting = false
            options.enableAppHangTracking = true
            options.enableAppHangTrackingV2 = true
            options.enableReportNonFullyBlockingAppHangs = false
            options.appHangTimeoutInterval = 2
            options.enableWatchdogTerminationTracking = true

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

            if #available(iOS 15.0, *) {
                options.enableMetricKit = true
                options.enableMetricKitRawPayload = false
            }

            options.beforeSend = { event in
                scrub(event: event)
            }
        }
    }

    private static func scrub(event: Event) -> Event? {
        let hasDiagnosticStack =
            event.stacktrace != nil ||
            event.exceptions?.isEmpty == false ||
            event.threads?.isEmpty == false
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

@_cdecl("reflect_start_native_diagnostics")
public func reflectStartNativeDiagnostics(
    _ dsnPointer: UnsafePointer<CChar>?,
    _ versionPointer: UnsafePointer<CChar>?
) {
    guard let dsnPointer, let versionPointer else {
        return
    }
    NativeDiagnostics.start(
        dsn: String(cString: dsnPointer),
        version: String(cString: versionPointer)
    )
}
