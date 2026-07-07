import AVFoundation
import Tauri
import UIKit
import WebKit

#if canImport(ActivityKit)
  import ActivityKit
#endif

/// The payload of the plugin's ~10 Hz `recordingLevel` event.
struct RecordingLevel: Encodable {
  /// Linear input level 0…1, from the recorder's average power meter.
  let level: Float
  /// Recorded time so far in milliseconds (pauses excluded).
  let elapsedMs: Double
}

/// The payload of the `recordingStopped` event — a stop the *native* side
/// initiated (interruption, route change, the duration cap, or an encoder
/// error). A stop the webview asked for resolves its own invoke instead and
/// never fires this event.
struct RecordingStopped: Encodable {
  /// Absolute path of the staged `.m4a`.
  let path: String
  let durationMs: Double
  /// `interruption` | `routeChange` | `maxDuration` | `error`
  let reason: String
}

/// `recordingStatus`'s response — whether a native recording is live right
/// now. A fresh webview mount uses this to find a recording that outlived
/// its UI (a reload or crash mid-memo) and stop-and-save it.
struct RecordingStatus: Encodable {
  let recording: Bool
  let elapsedMs: Double
}

/// The payload of the `nativeAction` event — an OS entry point (Siri, the
/// home-screen quick action, the lock-screen widget's `reflect://` URL)
/// asked for something only the webview can present.
struct NativeAction: Encodable {
  /// Currently only `recordAudio`.
  let action: String
}

struct QueueActionArgs: Decodable {
  let action: String
}

/// `stopRecording`'s response.
struct StopResponse: Encodable {
  let path: String
  let durationMs: Double
}

struct StagedFile: Encodable {
  let path: String
  /// Modification time in epoch milliseconds — effectively the stop time.
  let modifiedMs: Double
}

struct ListStagedResponse: Encodable {
  let files: [StagedFile]
}

struct ReadStagedResponse: Encodable {
  let base64: String
}

struct StartArgs: Decodable {
  /// Auto-stop cap in milliseconds, enforced natively via
  /// `record(forDuration:)` so it holds even if the webview never wakes.
  let maxDurationMs: Double
}

struct StagedPathArgs: Decodable {
  let path: String
}

/// Reflect's native audio-memo recorder (the mobile leg of the raw-first
/// pipeline in `packages/core/src/actions/audio-memo.ts`).
///
/// The V1 lesson this preserves: **capture must not depend on the webview.**
/// The recorder writes AAC mono 44.1 kHz `.m4a` straight into a staging
/// directory the plugin owns; audio-session interruptions (calls, Siri,
/// alarms), input-route loss (headphones unplugged), and the duration cap
/// all finalize the file natively, without JS involvement. Backgrounding
/// does NOT stop a recording: the app declares `UIBackgroundModes: audio`,
/// so a memo keeps capturing through screen lock (V1 parity) — level events
/// pause while backgrounded rather than piling into a suspended webview.
/// The webview ingests staged files into the graph when it can — including
/// a launch-time orphan scan for recordings whose stop it never saw — and
/// only then deletes them, so a crash anywhere in the chain loses nothing.
///
/// All state is confined to the main queue: invokes hop onto it, the meter
/// timer runs on it, and AVFoundation notifications are delivered to it.
class RecordingPlugin: Plugin {

  /// Why the native side is finalizing the file. `nil` while recording and
  /// for webview-initiated stops (which resolve their invoke instead).
  private enum NativeStopReason: String {
    case interruption
    case routeChange
    case maxDuration
    case error
    /// Siri "stop" or the Live Activity's stop button (in-process intents).
    case remote
  }

  /// The Siri/App-Intent bridge: intents compiled into the app target run in
  /// this process but in a different module, so they talk to the plugin
  /// through NotificationCenter. Names are duplicated in
  /// `gen/apple/Sources/reflect-open/` — keep them in sync.
  static let startRequestedNotification = Notification.Name(
    "app.reflect.recording.start-requested")
  static let stopRequestedNotification = Notification.Name(
    "app.reflect.recording.stop-requested")
  /// The home-screen quick action's `UIApplicationShortcutItemType`.
  static let recordShortcutType = "app.reflect.record-audio"
  /// The persisted native-action queue (the V1 handshake): an action fired
  /// from an OS entry point survives webview crashes and cold starts here
  /// until the webview confirms it ran.
  private static let pendingActionKey = "reflect.recording.pendingAction"

  /// The delegate-hook target for OS callbacks that carry no plugin context.
  private static weak var shared: RecordingPlugin?

  private var recorder: AVAudioRecorder?
  private var meterTimer: Timer?
  private var delegateProxy: RecorderDelegateProxy?
  /// Recorded milliseconds, captured before `stop()` zeroes `currentTime`.
  private var stoppedDurationMs: Double = 0
  /// Refreshed by the meter timer — the duration fallback for stops that
  /// never pass through `finalize` (the cap firing the delegate directly),
  /// where `currentTime` already reads 0.
  private var lastMeteredDurationMs: Double = 0
  /// The webview's `stopRecording` invoke, resolved when the file finalizes.
  private var pendingStop: Invoke?
  /// The webview's `cancelRecording` invoke — finalize, then delete.
  private var pendingCancel: Invoke?
  private var nativeStopReason: NativeStopReason?
  /// Bumped by cancel so a permission grant arriving later starts nothing.
  private var startSession = 0
  /// True while the app is backgrounded — level events pause (a suspended
  /// webview can't drain them) but the recording itself continues.
  private var isBackgrounded = false
  /// True once the webview called `actionsReady` — queued native actions
  /// deliver immediately from then on.
  private var webviewReadyForActions = false
  /// The live recording's Live Activity (`Activity<RecordingActivityAttributes>`,
  /// type-erased: stored properties can't be availability-restricted).
  private var liveActivity: Any?

  @objc public override func load(webview: WKWebView) {
    let center = NotificationCenter.default
    center.addObserver(
      self,
      selector: #selector(handleInterruption(_:)),
      name: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance()
    )
    center.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance()
    )
    // Backgrounding only gates event emission — with `UIBackgroundModes:
    // audio` the recording itself continues through screen lock.
    center.addObserver(
      self,
      selector: #selector(handleDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(handleWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
    // OS entry points (Siri App Intents run in this process, in the app
    // module) reach the plugin through NotificationCenter.
    center.addObserver(
      self,
      selector: #selector(handleStartRequested),
      name: Self.startRequestedNotification,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(handleStopRequested),
      name: Self.stopRequestedNotification,
      object: nil
    )
    Self.shared = self
    Self.installShortcutHandler()
  }

  // MARK: - Commands

  @objc public func startRecording(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartArgs.self)
    DispatchQueue.main.async {
      guard self.recorder == nil else {
        invoke.reject("already recording")
        return
      }
      let session = self.startSession
      let audioSession = AVAudioSession.sharedInstance()
      audioSession.requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard self.startSession == session, self.recorder == nil else {
            // Cancelled while the permission prompt was up, or a retry beat
            // this grant — nothing to start.
            invoke.reject("recording start was cancelled")
            return
          }
          guard granted else {
            invoke.reject("microphone access denied")
            return
          }
          do {
            try self.beginRecording(maxDurationMs: args.maxDurationMs)
            invoke.resolve()
          } catch {
            self.deactivateAudioSession()
            invoke.reject("recording failed to start: \(error.localizedDescription)")
          }
        }
      }
    }
  }

  @objc public func stopRecording(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let recorder = self.recorder else {
        invoke.reject("no active recording")
        return
      }
      guard self.pendingStop == nil, self.pendingCancel == nil else {
        invoke.reject("a stop is already in flight")
        return
      }
      self.pendingStop = invoke
      self.finalize(recorder)
    }
  }

  @objc public func cancelRecording(_ invoke: Invoke) {
    DispatchQueue.main.async {
      // Cancel during the permission prompt: invalidate the pending start.
      self.startSession += 1
      guard let recorder = self.recorder else {
        invoke.resolve()
        return
      }
      guard self.pendingStop == nil, self.pendingCancel == nil else {
        invoke.reject("a stop is already in flight")
        return
      }
      self.pendingCancel = invoke
      self.finalize(recorder)
    }
  }

  /// Whether a recording is live right now. A fresh webview mount asks this
  /// to find a recording that outlived its UI (a reload or crash mid-memo)
  /// and stop-and-save it instead of leaving a hidden hot microphone.
  @objc public func recordingStatus(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let recorder = self.recorder
      invoke.resolve(
        RecordingStatus(
          recording: recorder != nil,
          elapsedMs: (recorder?.currentTime ?? 0) * 1000
        ))
    }
  }

  @objc public func listStaged(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        let directory = try self.stagingDirectory()
        let live = self.recorder?.url.standardizedFileURL.path
        let urls = try FileManager.default.contentsOfDirectory(
          at: directory,
          includingPropertiesForKeys: [.contentModificationDateKey],
          options: [.skipsHiddenFiles]
        )
        let files: [StagedFile] = urls.compactMap { url in
          // The in-flight recording's file is not staged output yet.
          guard url.standardizedFileURL.path != live else { return nil }
          let modified =
            (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? Date(timeIntervalSince1970: 0)
          return StagedFile(
            path: url.standardizedFileURL.path,
            modifiedMs: modified.timeIntervalSince1970 * 1000
          )
        }
        invoke.resolve(ListStagedResponse(files: files.sorted { $0.path < $1.path }))
      } catch {
        invoke.reject("listing staged recordings failed: \(error.localizedDescription)")
      }
    }
  }

  @objc public func readStaged(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StagedPathArgs.self)
    DispatchQueue.main.async {
      do {
        let url = try self.stagedURL(for: args.path)
        let data = try Data(contentsOf: url)
        invoke.resolve(ReadStagedResponse(base64: data.base64EncodedString()))
      } catch {
        invoke.reject("reading staged recording failed: \(error.localizedDescription)")
      }
    }
  }

  @objc public func deleteStaged(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StagedPathArgs.self)
    DispatchQueue.main.async {
      do {
        let url = try self.stagedURL(for: args.path)
        if FileManager.default.fileExists(atPath: url.path) {
          try FileManager.default.removeItem(at: url)
        }
        invoke.resolve()
      } catch {
        invoke.reject("deleting staged recording failed: \(error.localizedDescription)")
      }
    }
  }

  // MARK: - Recording lifecycle (main queue)

  private func beginRecording(maxDurationMs: Double) throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .default)
    try audioSession.setActive(true)

    let directory = try stagingDirectory()
    let name = "recording-\(Int(Date().timeIntervalSince1970 * 1000)).m4a"
    let url = directory.appendingPathComponent(name)
    // AAC mono 44.1 kHz — the V1 recorder's format, and the `.m4a` container
    // the transcription providers accept (`AUDIO_EXTENSION_BY_MIME`).
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44_100.0,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
    ]
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    let proxy = RecorderDelegateProxy(
      onFinish: { [weak self] successfully in
        self?.recorderDidFinish(successfully: successfully)
      },
      onEncodeError: { [weak self] in
        self?.nativeStopReason = self?.nativeStopReason ?? .error
      }
    )
    recorder.delegate = proxy
    recorder.isMeteringEnabled = true
    guard recorder.record(forDuration: maxDurationMs / 1000) else {
      deactivateAudioSession()
      throw NSError(
        domain: "app.reflect.recording", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "the audio recorder refused to start"])
    }

    self.recorder = recorder
    self.delegateProxy = proxy
    self.nativeStopReason = nil
    self.stoppedDurationMs = 0
    self.lastMeteredDurationMs = 0
    // The screen must not sleep mid-memo (V1 parity).
    UIApplication.shared.isIdleTimerDisabled = true
    self.meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) {
      [weak self] _ in
      self?.emitLevel()
    }
    startLiveActivity()
  }

  /// Capture the duration and ask the recorder to finalize the file; the
  /// delegate callback (`recorderDidFinish`) settles whoever is waiting.
  private func finalize(_ recorder: AVAudioRecorder, native reason: NativeStopReason? = nil) {
    nativeStopReason = reason
    stoppedDurationMs = recorder.currentTime * 1000
    meterTimer?.invalidate()
    meterTimer = nil
    recorder.stop()
  }

  private func recorderDidFinish(successfully: Bool) {
    guard let recorder = self.recorder else { return }
    let path = recorder.url.standardizedFileURL.path
    // `record(forDuration:)` hitting the cap lands here with no local cause
    // recorded — every other path set its reason (or a pending invoke) first.
    let reason =
      nativeStopReason ?? (!successfully ? .error : .maxDuration)
    let durationMs = stoppedDurationMs > 0 ? stoppedDurationMs : lastMeteredDurationMs

    self.recorder = nil
    self.delegateProxy = nil
    self.nativeStopReason = nil
    self.meterTimer?.invalidate()
    self.meterTimer = nil
    UIApplication.shared.isIdleTimerDisabled = false
    deactivateAudioSession()
    endLiveActivity()

    if let cancel = pendingCancel {
      pendingCancel = nil
      try? FileManager.default.removeItem(atPath: path)
      cancel.resolve()
      return
    }
    if let stop = pendingStop {
      pendingStop = nil
      stop.resolve(StopResponse(path: path, durationMs: durationMs))
      return
    }
    // A native-initiated stop: the file is staged output now — tell the
    // webview if it is alive; the orphan scan covers it if it is not.
    do {
      try trigger(
        "recordingStopped",
        data: RecordingStopped(path: path, durationMs: durationMs, reason: reason.rawValue))
    } catch {
      Logger.error("recordingStopped event failed to serialize: \(error)")
    }
  }

  private func emitLevel() {
    guard let recorder = self.recorder, recorder.isRecording else { return }
    lastMeteredDurationMs = recorder.currentTime * 1000
    // A suspended webview can't drain events — keep tracking the duration
    // above, but only emit while the app is in the foreground.
    guard !isBackgrounded else { return }
    recorder.updateMeters()
    // Average power is dBFS (−160…0); linearize for the waveform.
    let level = pow(10, recorder.averagePower(forChannel: 0) / 20)
    do {
      try trigger(
        "recordingLevel",
        data: RecordingLevel(level: level, elapsedMs: lastMeteredDurationMs))
    } catch {
      Logger.error("recordingLevel event failed to serialize: \(error)")
    }
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - Session notifications

  @objc private func handleInterruption(_ notification: Notification) {
    guard
      let recorder = self.recorder,
      let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: rawType) == .began
    else { return }
    // A call, Siri, or an alarm took the session: keep what was recorded
    // rather than gambling on a resume that may never come (V1 parity).
    finalize(recorder, native: .interruption)
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    guard
      let recorder = self.recorder,
      let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable
    else { return }
    // The input device went away (headset unplugged, Bluetooth mic dropped):
    // stop instead of silently recording the wrong microphone.
    finalize(recorder, native: .routeChange)
  }

  @objc private func handleDidEnterBackground() {
    isBackgrounded = true
  }

  @objc private func handleWillEnterForeground() {
    isBackgrounded = false
  }

  // MARK: - Native actions (the V1 handshake)

  /// The webview's action surface is mounted and listening: deliver the
  /// queued action, if any. The action stays queued until `actionPerformed`
  /// — a webview that crashes mid-delivery gets it again on the next launch.
  @objc public func actionsReady(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.webviewReadyForActions = true
      self.deliverPendingAction()
      invoke.resolve()
    }
  }

  /// The webview executed the delivered action — retire it from the queue.
  @objc public func actionPerformed(_ invoke: Invoke) {
    DispatchQueue.main.async {
      UserDefaults.standard.removeObject(forKey: Self.pendingActionKey)
      invoke.resolve()
    }
  }

  /// Queue a native action from the Rust side (the lock-screen widget's
  /// `reflect://record-audio` URL arrives as a tao `Opened` event).
  @objc public func queueAction(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(QueueActionArgs.self)
    DispatchQueue.main.async {
      self.queueNativeAction(args.action)
      invoke.resolve()
    }
  }

  /// Persist the request, then deliver it if the webview is listening. The
  /// two-step shape is the point (see `native-entry-points.md`): OS entry
  /// points can fire before the webview exists or right before it dies, and
  /// the action must be neither lost nor double-run.
  private func queueNativeAction(_ action: String) {
    UserDefaults.standard.set(action, forKey: Self.pendingActionKey)
    deliverPendingAction()
  }

  private func deliverPendingAction() {
    guard
      webviewReadyForActions,
      let action = UserDefaults.standard.string(forKey: Self.pendingActionKey)
    else { return }
    do {
      try trigger("nativeAction", data: NativeAction(action: action))
    } catch {
      Logger.error("nativeAction event failed to serialize: \(error)")
    }
  }

  @objc private func handleStartRequested() {
    // Starting needs the webview (recording UI, then capture) — queue it.
    queueNativeAction("recordAudio")
  }

  @objc private func handleStopRequested() {
    // Stopping is pure native work: finalize now, even with the app
    // backgrounded or the webview dead; ingest follows the usual paths.
    guard let recorder = self.recorder, pendingStop == nil, pendingCancel == nil else { return }
    finalize(recorder, native: .remote)
  }

  /// The home-screen quick action arrives on the app delegate — a runtime
  /// class tao registers without implementing
  /// `application:performActionForShortcutItem:completionHandler:`. Add the
  /// method to that class; if some future delegate already implements it,
  /// leave theirs alone (the quick action degrades to just opening the app).
  private static var didInstallShortcutHandler = false
  private static func installShortcutHandler() {
    guard
      !didInstallShortcutHandler,
      let delegate = UIApplication.shared.delegate,
      let delegateClass = object_getClass(delegate)
    else { return }
    didInstallShortcutHandler = true
    let selector = NSSelectorFromString(
      "application:performActionForShortcutItem:completionHandler:")
    guard class_getInstanceMethod(delegateClass, selector) == nil else { return }
    let block:
      @convention(block) (
        AnyObject, UIApplication, UIApplicationShortcutItem, @escaping (Bool) -> Void
      ) -> Void = { _, _, item, completion in
        let handled = item.type == RecordingPlugin.recordShortcutType
        if handled {
          DispatchQueue.main.async {
            RecordingPlugin.shared?.queueNativeAction("recordAudio")
          }
        }
        completion(handled)
      }
    class_addMethod(
      delegateClass, selector, imp_implementationWithBlock(block), "v@:@@@?")
  }

  // MARK: - Live Activity

  /// Show the recording on the lock screen / Dynamic Island: elapsed timer
  /// plus (iOS 17+) a stop button. Requires iOS 16.2 and the user not having
  /// disabled Live Activities — both degrade to "no activity", never an error.
  private func startLiveActivity() {
    #if canImport(ActivityKit)
      if #available(iOS 16.2, *) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let content = ActivityContent(
          state: RecordingActivityAttributes.ContentState(startedAt: Date()),
          staleDate: nil
        )
        do {
          liveActivity = try Activity.request(
            attributes: RecordingActivityAttributes(),
            content: content,
            pushType: nil
          )
        } catch {
          Logger.error("recording Live Activity failed to start: \(error)")
        }
      }
    #endif
  }

  private func endLiveActivity() {
    #if canImport(ActivityKit)
      if #available(iOS 16.2, *) {
        guard let activity = liveActivity as? Activity<RecordingActivityAttributes> else {
          return
        }
        liveActivity = nil
        Task {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
    #endif
  }

  // MARK: - Staging directory

  private func stagingDirectory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("audio-memo-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  /// Resolve a caller-supplied path, refusing anything outside staging — the
  /// webview must not be able to read or delete arbitrary sandbox files.
  private func stagedURL(for path: String) throws -> URL {
    let directory = try stagingDirectory().standardizedFileURL
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard url.path.hasPrefix(directory.path + "/") else {
      throw NSError(
        domain: "app.reflect.recording", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "path is outside the recording staging directory"])
    }
    return url
  }
}

/// `AVAudioRecorderDelegate` requires `NSObject`; a tiny proxy keeps the
/// plugin class free of that conformance and the callbacks on closures.
private class RecorderDelegateProxy: NSObject, AVAudioRecorderDelegate {
  private let onFinish: (Bool) -> Void
  private let onEncodeError: () -> Void

  init(onFinish: @escaping (Bool) -> Void, onEncodeError: @escaping () -> Void) {
    self.onFinish = onFinish
    self.onEncodeError = onEncodeError
  }

  func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    onFinish(flag)
  }

  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    onEncodeError()
  }
}

@_cdecl("init_plugin_recording")
func initPlugin() -> Plugin {
  return RecordingPlugin()
}
