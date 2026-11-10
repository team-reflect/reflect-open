#if os(iOS)
import AVFoundation
public import Foundation
import RecordingShared
import UIKit
import UserNotifications

#if canImport(ActivityKit)
import ActivityKit
#endif

/// The payload of the plugin's ~10 Hz `recordingLevel` event.
public struct RecordingLevel: Encodable {
  /// Linear input level 0…1, from the recorder's average power meter.
  public let level: Float
  /// Recorded time so far in milliseconds (pauses excluded).
  public let elapsedMs: Double
}

/// The payload of the `recordingSegment` event: a finished segment of a
/// session that is still recording. The final segment never arrives here (a
/// webview stop resolves its own invoke, a native stop fires
/// `recordingStopped`), so every segment is announced exactly once.
public struct RecordingSegment: Encodable {
  /// Absolute path of the staged `.m4a`.
  public let path: String
  /// The session's identity timestamp in epoch ms, shared by every segment.
  public let sessionStartedMs: Double
  /// 1-based position within the session.
  public let part: Int
}

/// The payload of the `recordingStopped` event — a stop the *native* side
/// initiated (interruption, route change, a remote stop, or an encoder
/// error). A stop the webview asked for resolves its own invoke instead and
/// never fires this event.
public struct RecordingStopped: Encodable {
  /// Absolute path of the staged `.m4a`, already `-end`-marked.
  public let path: String
  /// The session's identity timestamp in epoch ms, shared by every segment.
  public let sessionStartedMs: Double
  /// 1-based position of this final segment.
  public let part: Int
  /// The whole session's recorded length, not this segment's.
  public let durationMs: Double
  /// `interruption` | `routeChange` | `remote` | `error`
  public let reason: String
}

/// `recordingStatus`'s response — whether a native recording is live right
/// now. A fresh webview mount uses this to find a recording that outlived
/// its UI (a reload or crash mid-memo) and stop-and-save it.
public struct RecordingStatus: Encodable {
  public let recording: Bool
  /// The session's recorded length so far, across every segment.
  public let elapsedMs: Double
}

/// The payload of the `nativeAction` event — an OS entry point (Siri, the
/// home-screen quick action, the lock-screen widget's `reflect://` URL)
/// asked for something only the webview can present.
public struct NativeAction: Encodable {
  /// Currently only `recordAudio`.
  public let action: String
}

/// `stopRecording`'s response: the session's final segment.
public struct StopResponse: Encodable {
  /// Absolute path of the staged `.m4a`, already `-end`-marked.
  public let path: String
  /// The session's identity timestamp in epoch ms, shared by every segment.
  public let sessionStartedMs: Double
  /// 1-based position of this final segment.
  public let part: Int
  /// The whole session's recorded length.
  public let durationMs: Double
}

/// `startRecording`'s response: the identity the webview files this session's
/// segments under.
public struct StartResponse: Encodable {
  public let sessionStartedMs: Double
}

/// An event for the host to forward to the webview.
public enum RecordingEvent {
  /// `recordingLevel`, ~10 Hz while recording in the foreground.
  case level(RecordingLevel)
  /// `recordingSegment`, a finished segment of a session still recording.
  case segment(RecordingSegment)
  /// `recordingStopped`, a stop the native side initiated.
  case stopped(RecordingStopped)
  /// `nativeAction`, an OS entry point's request for the webview.
  case nativeAction(NativeAction)
}

/// A failed command; `message` is what the host rejects the call with.
public struct RecordingError: Error {
  public let message: String
}

/// Reflect's native audio-memo recorder (the mobile leg of the raw-first
/// pipeline in `packages/core/src/audio/audio-memo.ts`).
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
/// All state is confined to the main queue: the host calls every method on
/// it, the meter timer runs on it, and AVFoundation notifications are
/// delivered to it. Completions run on it too.
public final class RecordingEngine: NSObject {

  /// Why the native side is finalizing the file. `nil` while recording and
  /// for webview-initiated stops (which resolve their invoke instead).
  private enum NativeStopReason: String {
    case interruption
    case routeChange
    case error
    /// Siri "stop" or the Live Activity's stop button (in-process intents).
    case remote
  }

  /// The persisted native-action queue (the V1 handshake): an action fired
  /// from an OS entry point survives webview crashes and cold starts here
  /// until the webview confirms it ran.
  private static let pendingActionKey = "reflect.recording.pendingAction"
  private static let pendingActionQueuedAtKey = "reflect.recording.pendingActionQueuedAt"
  /// A queued action older than this is dropped, not delivered: re-firing a
  /// crash-orphaned request seconds later is the contract, but turning the
  /// microphone on days after the tap that asked for it is a surprise no
  /// user reads as their own action.
  private static let pendingActionMaxAgeSeconds: TimeInterval = 15 * 60
  /// The repeating "still recording" reminder's request id; one per app, so a
  /// later delivery replaces the banner instead of stacking another one.
  private static let reminderRequestId = "app.reflect.recording.reminder"
  /// `UNTimeIntervalNotificationTrigger` refuses anything under a minute.
  private static let minimumReminderSeconds: TimeInterval = 60

  private var recorder: AVAudioRecorder?
  private var meterTimer: Timer?
  private var delegateProxy: RecorderDelegateProxy?
  /// The live session's identity timestamp in epoch ms: the memo every
  /// segment belongs to, and the staged filenames' session key. 0 between
  /// sessions.
  private var sessionStartedMs: Double = 0
  /// 1-based index of the segment being recorded (0 between sessions).
  private var partIndex = 0
  /// Rotate the recorder after this much audio.
  private var segmentMs: Double = 0
  /// Finished segments' total duration: `currentTime` restarts at zero every
  /// rotation, but the UI counts the whole session.
  private var elapsedBeforeSegmentMs: Double = 0
  /// The current segment's recorded milliseconds, captured before `stop()`
  /// zeroes `currentTime`.
  private var stoppedDurationMs: Double = 0
  /// Refreshed by the meter timer — the current segment's duration fallback
  /// for stops that never pass through `finalize` (a rotation boundary firing
  /// the delegate directly), where `currentTime` already reads 0.
  private var lastMeteredSegmentMs: Double = 0
  /// The webview's `stopRecording` call, settled when the file finalizes.
  private var pendingStop: ((Result<StopResponse, RecordingError>) -> Void)?
  /// The webview's `cancelRecording` call — finalize, then delete.
  private var pendingCancel: ((Result<Void, RecordingError>) -> Void)?
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
  /// The staging directory the recorder writes into.
  private let stagingDirectory: () throws -> URL

  /// Receives every event; set before `activate()`.
  public var onEvent: ((RecordingEvent) -> Void)?
  /// Receives error log lines.
  public var log: ((String) -> Void)?

  /// `stagingDirectory` returns the directory to record into, creating it.
  public init(stagingDirectory: @escaping () throws -> URL) {
    self.stagingDirectory = stagingDirectory
  }

  /// Start observing the audio session, app lifecycle, and OS entry points,
  /// and clear what a previous process left behind. Call once, when the host
  /// loads.
  public func activate() {
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
    // OS entry points handled in the app module (Siri App Intents, the
    // home-screen quick action) reach the plugin through NotificationCenter.
    center.addObserver(
      self,
      selector: #selector(handleStartRequested),
      name: .recordingStartRequested,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(handleStopRequested),
      name: .recordingStopRequested,
      object: nil
    )
    // A crash mid-recording leaves its Live Activity counting on the lock
    // screen with nothing behind it (the orphan scan saves the audio, but
    // nobody ended the activity), and its reminder still firing every half
    // hour. A recording cannot outlive the app process, so nothing can be
    // legitimately live at plugin load: clear both.
    endStaleLiveActivities()
    clearReminder()
  }

  // MARK: - Commands

  /// `segmentMs`: rotate the recorder after this much audio; each segment
  /// lands as its own complete `.m4a`, so a session has no length limit.
  /// `reminderMs`: remind the user this often while the session runs.
  public func start(
    segmentMs: Double, reminderMs: Double,
    completion: @escaping (Result<StartResponse, RecordingError>) -> Void
  ) {
    guard self.recorder == nil else {
      completion(.failure(RecordingError(message: "already recording")))
      return
    }
    let session = self.startSession
    let audioSession = AVAudioSession.sharedInstance()
    audioSession.requestRecordPermission { granted in
      DispatchQueue.main.async {
        guard self.startSession == session, self.recorder == nil else {
          // Cancelled while the permission prompt was up, or a retry beat
          // this grant — nothing to start.
          completion(.failure(RecordingError(message: "recording start was cancelled")))
          return
        }
        guard granted else {
          completion(.failure(RecordingError(message: "microphone access denied")))
          return
        }
        do {
          try self.beginSession(segmentMs: segmentMs, reminderMs: reminderMs)
          completion(.success(StartResponse(sessionStartedMs: self.sessionStartedMs)))
        } catch {
          self.deactivateAudioSession()
          completion(
            .failure(
              RecordingError(
                message: "recording failed to start: \(error.localizedDescription)")))
        }
      }
    }
  }

  public func stop(completion: @escaping (Result<StopResponse, RecordingError>) -> Void) {
    guard let recorder = self.recorder else {
      completion(.failure(RecordingError(message: "no active recording")))
      return
    }
    guard self.pendingStop == nil, self.pendingCancel == nil else {
      completion(.failure(RecordingError(message: "a stop is already in flight")))
      return
    }
    self.pendingStop = completion
    self.finalize(recorder)
  }

  public func cancel(completion: @escaping (Result<Void, RecordingError>) -> Void) {
    // Cancel during the permission prompt: invalidate the pending start.
    self.startSession += 1
    guard let recorder = self.recorder else {
      completion(.success(()))
      return
    }
    guard self.pendingStop == nil, self.pendingCancel == nil else {
      completion(.failure(RecordingError(message: "a stop is already in flight")))
      return
    }
    self.pendingCancel = completion
    self.finalize(recorder)
  }

  /// Whether a recording is live right now. A fresh webview mount asks this
  /// to find a recording that outlived its UI (a reload or crash mid-memo)
  /// and stop-and-save it instead of leaving a hidden hot microphone.
  public func status() -> RecordingStatus {
    let recorder = self.recorder
    return RecordingStatus(
      recording: recorder != nil,
      elapsedMs: recorder.map { self.elapsedBeforeSegmentMs + $0.currentTime * 1000 } ?? 0
    )
  }

  /// The staged recordings, without the segment being recorded.
  public func listStaged() throws -> [StagedFile] {
    try RecordingFiles.listStaged(
      in: try self.stagingDirectory(),
      excluding: self.recorder?.url.standardizedFileURL.path)
  }

  /// Delete one staged recording; a missing file is not an error.
  public func deleteStaged(path: String) throws {
    let url = try self.stagedURL(for: path)
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }

  // MARK: - Recording lifecycle (main queue)

  /// Open the audio session and start its first segment. Everything that
  /// belongs to the *session* rather than to one segment lives here: the
  /// audio session, the idle-timer hold, the meter timer, and the Live
  /// Activity all survive rotations untouched.
  private func beginSession(segmentMs: Double, reminderMs: Double) throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
    try audioSession.setActive(true)

    // Whole milliseconds: the staged filenames carry `Int(sessionStartedMs)`,
    // so the events must not report a fraction the filenames cannot.
    self.sessionStartedMs = (Date().timeIntervalSince1970 * 1000).rounded(.down)
    self.segmentMs = segmentMs
    self.partIndex = 0
    self.elapsedBeforeSegmentMs = 0
    do {
      try startSegment()
    } catch {
      resetSession()
      throw error
    }
    // The screen must not sleep mid-memo (V1 parity).
    UIApplication.shared.isIdleTimerDisabled = true
    self.meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) {
      [weak self] _ in
      self?.emitLevel()
    }
    startLiveActivity()
    scheduleReminder(intervalMs: reminderMs)
  }

  /// Start the next segment on the already-open audio session.
  /// `record(forDuration:)` ends it natively at the rotation boundary, so
  /// rotation holds with the app backgrounded and the webview asleep.
  private func startSegment() throws {
    let part = partIndex + 1
    let url = try stagingDirectory().appendingPathComponent(
      RecordingFiles.stagedName(sessionStartedMs: sessionStartedMs, part: part, end: false))
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
    guard recorder.record(forDuration: segmentMs / 1000) else {
      // A refused start may still have created the file: leaving it behind
      // would give the session a phantom segment with no end marker.
      try? FileManager.default.removeItem(at: url)
      throw NSError(
        domain: "app.reflect.recording", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "the audio recorder refused to start"])
    }

    self.recorder = recorder
    self.delegateProxy = proxy
    self.partIndex = part
    self.nativeStopReason = nil
    self.stoppedDurationMs = 0
    self.lastMeteredSegmentMs = 0
  }

  /// Rename a finished segment to carry the session's end marker; on failure
  /// the segment keeps its open name.
  private func markEnded(_ path: String) -> String {
    do {
      return try RecordingFiles.markEnded(
        path: path, sessionStartedMs: sessionStartedMs, part: partIndex)
    } catch {
      self.log?("marking the session's final segment failed: \(error)")
      return path
    }
  }

  /// Delete every staged segment of the live session: a cancel must leave
  /// nothing for the orphan scan to resurrect.
  private func discardSession() throws {
    let urls = try RecordingFiles.sessionFiles(
      in: try stagingDirectory(), sessionStartedMs: sessionStartedMs)
    for url in urls {
      try FileManager.default.removeItem(at: url)
    }
  }

  private func resetSession() {
    sessionStartedMs = 0
    partIndex = 0
    segmentMs = 0
    elapsedBeforeSegmentMs = 0
    stoppedDurationMs = 0
    lastMeteredSegmentMs = 0
    nativeStopReason = nil
  }

  private func emitSegment(path: String, part: Int) {
    onEvent?(
      .segment(RecordingSegment(path: path, sessionStartedMs: sessionStartedMs, part: part)))
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
    let segmentDurationMs = stoppedDurationMs > 0 ? stoppedDurationMs : lastMeteredSegmentMs
    let sessionDurationMs = elapsedBeforeSegmentMs + segmentDurationMs
    self.recorder = nil
    self.delegateProxy = nil

    // A segment that ended on its own boundary is a rotation, not a stop: the
    // audio session, the idle-timer hold, the meter timer, and the Live
    // Activity all stay as they are.
    let rotating =
      successfully && nativeStopReason == nil && pendingStop == nil && pendingCancel == nil
    if rotating {
      let finishedPart = partIndex
      elapsedBeforeSegmentMs = sessionDurationMs
      do {
        try startSegment()
        emitSegment(path: path, part: finishedPart)
        return
      } catch {
        // Nothing is recording now: fall through to the teardown below and
        // close the session on the segment that just landed, rather than
        // leave the audio session, the meter timer, the idle-timer hold, the
        // Live Activity, and the reminder running behind a dead recorder.
        self.log?("rotating to the next segment failed: \(error)")
        nativeStopReason = .error
      }
    }

    if !successfully && nativeStopReason == nil {
      nativeStopReason = .error
    }
    self.meterTimer?.invalidate()
    self.meterTimer = nil
    UIApplication.shared.isIdleTimerDisabled = false
    deactivateAudioSession()
    endLiveActivity()
    clearReminder()

    if let cancel = pendingCancel {
      pendingCancel = nil
      // Cancel must be durable: a file left in staging would be resurrected as
      // a memo by the orphan scan, undoing the discard. Every segment of the
      // session goes, not only the one that was recording. Report the failure
      // so the caller can surface it rather than silently keeping the audio.
      do {
        try discardSession()
        cancel(.success(()))
      } catch {
        cancel(
          .failure(
            RecordingError(
              message: "discarding the recording failed: \(error.localizedDescription)")))
      }
      resetSession()
      return
    }
    if let stop = pendingStop {
      pendingStop = nil
      // A failed finalization produced no usable file — reject rather than
      // hand back a StopResponse pointing at a corrupt/absent recording.
      if !successfully {
        stop(.failure(RecordingError(message: "the recording failed to finalize")))
      } else {
        stop(
          .success(
            StopResponse(
              path: markEnded(path), sessionStartedMs: sessionStartedMs, part: partIndex,
              durationMs: sessionDurationMs)))
      }
      resetSession()
      return
    }
    endSession(path: path, durationMs: sessionDurationMs)
  }

  /// Announce a session the native side ended: the final segment is staged
  /// output now — tell the webview if it is alive; the orphan scan covers it
  /// if it is not.
  private func endSession(path: String, durationMs: Double) {
    // Every path that lands here set a reason first (a rotation is the only
    // causeless finish, and it returns above), so the fallback is a formality.
    let reason = nativeStopReason ?? .error
    let finalPath = markEnded(path)
    onEvent?(
      .stopped(
        RecordingStopped(
          path: finalPath, sessionStartedMs: sessionStartedMs, part: partIndex,
          durationMs: durationMs, reason: reason.rawValue)))
    resetSession()
  }

  private func emitLevel() {
    guard let recorder = self.recorder, recorder.isRecording else { return }
    lastMeteredSegmentMs = recorder.currentTime * 1000
    // A suspended webview can't drain events — keep tracking the duration
    // above, but only emit while the app is in the foreground.
    guard !isBackgrounded else { return }
    recorder.updateMeters()
    // Average power is dBFS (−160…0); linearize for the waveform.
    let level = pow(10, recorder.averagePower(forChannel: 0) / 20)
    onEvent?(
      .level(
        RecordingLevel(level: level, elapsedMs: elapsedBeforeSegmentMs + lastMeteredSegmentMs)))
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
  public func actionsReady() {
    self.webviewReadyForActions = true
    self.deliverPendingAction()
  }

  /// The webview executed the delivered action — retire it from the queue.
  public func actionPerformed() {
    Self.clearPendingAction()
  }

  /// Queue a native action from the Rust side (the lock-screen widget's
  /// `reflect://record-audio` URL arrives as a tao `Opened` event).
  public func queueAction(_ action: String) {
    self.queueNativeAction(action)
  }

  /// Persist the request, then deliver it if the webview is listening. The
  /// two-step shape is the point (see `native-entry-points.md`): OS entry
  /// points can fire before the webview exists or right before it dies, and
  /// the action must be neither lost nor double-run.
  private func queueNativeAction(_ action: String) {
    UserDefaults.standard.set(action, forKey: Self.pendingActionKey)
    UserDefaults.standard.set(
      Date().timeIntervalSince1970, forKey: Self.pendingActionQueuedAtKey)
    deliverPendingAction()
  }

  private func deliverPendingAction() {
    guard
      webviewReadyForActions,
      let action = UserDefaults.standard.string(forKey: Self.pendingActionKey)
    else { return }
    let queuedAt = UserDefaults.standard.double(forKey: Self.pendingActionQueuedAtKey)
    guard Date().timeIntervalSince1970 - queuedAt <= Self.pendingActionMaxAgeSeconds else {
      Self.clearPendingAction()
      return
    }
    onEvent?(.nativeAction(NativeAction(action: action)))
  }

  private static func clearPendingAction() {
    UserDefaults.standard.removeObject(forKey: pendingActionKey)
    UserDefaults.standard.removeObject(forKey: pendingActionQueuedAtKey)
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

  // MARK: - Recording reminder

  /// Remind the user that a recording is still running. Recording has no
  /// duration cap, so this repeating notification is the only thing between a
  /// forgotten tap and a microphone that runs until the battery dies. The
  /// plugin owns the schedule rather than the webview: a session the native
  /// side ends (a call, an encoder error) has to clear it even when the
  /// webview is gone.
  private func scheduleReminder(intervalMs: Double) {
    let interval = max(intervalMs / 1000, Self.minimumReminderSeconds)
    let center = UNUserNotificationCenter.current()
    // Asked on the first recording rather than at launch, and never blocking:
    // a denial is not an error, it just leaves the Live Activity as the only
    // running indicator.
    center.requestAuthorization(options: [.alert]) { granted, error in
      if let error {
        self.log?("recording reminder authorization failed: \(error)")
        return
      }
      guard granted else { return }
      DispatchQueue.main.async {
        // The session may have ended while the permission prompt was up.
        guard self.recorder != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = "Reflect is still recording"
        content.body = "Open Reflect to stop the recording."
        // Silent on purpose: the microphone is live, and an alert tone would
        // land in the recording itself. The elapsed time lives on the Live
        // Activity, since a repeating request cannot carry a changing body.
        content.sound = nil
        let request = UNNotificationRequest(
          identifier: Self.reminderRequestId,
          content: content,
          trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: true)
        )
        center.add(request) { error in
          if let error {
            self.log?("scheduling the recording reminder failed: \(error)")
          }
        }
      }
    }
  }

  /// Clear the reminder and any banner it already delivered.
  private func clearReminder() {
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [Self.reminderRequestId])
    center.removeDeliveredNotifications(withIdentifiers: [Self.reminderRequestId])
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
        self.log?("recording Live Activity failed to start: \(error)")
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

  private func endStaleLiveActivities() {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        for activity in Activity<RecordingActivityAttributes>.activities {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
    }
    #endif
  }

  // MARK: - Staging directory

  /// Resolve a caller-supplied path, refusing anything outside staging.
  private func stagedURL(for path: String) throws -> URL {
    try RecordingFiles.stagedURL(for: path, in: try stagingDirectory())
  }
}

/// `AVAudioRecorderDelegate` requires `NSObject`; a tiny proxy keeps the
/// engine free of that conformance and the callbacks on closures.
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
#endif
