import ReflectCoreFFI
import TypesShared

extension ReflectCore {
  /// Writes one line to the core's log: stderr and `<appDataDir>/logs/reflect.log`.
  /// A line before the first core starts is dropped.
  static func log(_ level: HostLogLevel, _ message: String) {
    switch level {
    case .error: reflect_core_log(Int32(REFLECT_LOG_ERROR), message)
    case .warn: reflect_core_log(Int32(REFLECT_LOG_WARN), message)
    case .info: reflect_core_log(Int32(REFLECT_LOG_INFO), message)
    }
  }
}
