public import Foundation
public import TypesShared

/// The recording staging directory's file naming and lookups.
public enum RecordingFiles {
  /// `recording-<sessionStartMs>.part-NNN[-end].m4a`. Session identity,
  /// segment position, and the end marker all live in the name, so a crash
  /// orphan regroups into one session from the staging directory alone.
  public static func stagedName(sessionStartedMs: Double, part: Int, end: Bool) -> String {
    let position = String(format: "%03d", part)
    return "recording-\(Int(sessionStartedMs)).part-\(position)\(end ? "-end" : "").m4a"
  }

  /// Parse a staged filename back into its session identity and position. A
  /// legacy name (`recording-<ms>.m4a`, written before segmented sessions)
  /// reads as a one-part closed session keyed by the file's mtime, which is
  /// the identity the webview already ingests those under: an upgrade with an
  /// orphan pending must not re-ingest it under a second name.
  public static func stagedInfo(path: String, modifiedMs: Double) -> StagedRecordingFile? {
    let name = URL(fileURLWithPath: path).lastPathComponent
    guard name.hasPrefix("recording-"), name.hasSuffix(".m4a") else { return nil }
    let body = name.dropFirst("recording-".count).dropLast(".m4a".count)
    let fields = body.split(separator: ".", omittingEmptySubsequences: false)
    guard let first = fields.first, let session = Double(String(first)) else { return nil }
    if fields.count == 1 {
      return StagedRecordingFile(
        path: path, sessionStartedMs: modifiedMs, part: 1, end: true, modifiedMs: modifiedMs)
    }
    guard fields.count == 2, fields[1].hasPrefix("part-") else { return nil }
    let end = fields[1].hasSuffix("-end")
    // A session has no length limit, so the position is not fixed-width:
    // strip the prefix and the marker, then read whatever digits remain.
    var digits = fields[1].dropFirst("part-".count)
    if end {
      digits = digits.dropLast("-end".count)
    }
    guard let part = UInt32(digits), part > 0 else { return nil }
    return StagedRecordingFile(
      path: path, sessionStartedMs: session, part: part, end: end, modifiedMs: modifiedMs)
  }

  /// Rename a finished segment to carry the session's end marker and return
  /// its new path. The marker must live in the filename, not only in the
  /// event: a crash between the finalize and the webview's ingest would
  /// otherwise leave the session looking open until the age fallback closes
  /// it half an hour later.
  public static func markEnded(path: String, sessionStartedMs: Double, part: Int) throws -> String {
    let url = URL(fileURLWithPath: path)
    let ended = url.deletingLastPathComponent().appendingPathComponent(
      stagedName(sessionStartedMs: sessionStartedMs, part: part, end: true))
    try FileManager.default.moveItem(at: url, to: ended)
    return ended.standardizedFileURL.path
  }

  /// Every staged segment of one session in `directory`.
  public static func sessionFiles(in directory: URL, sessionStartedMs: Double) throws -> [URL] {
    let prefix = "recording-\(Int(sessionStartedMs))."
    let urls = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
    return urls.filter { $0.lastPathComponent.hasPrefix(prefix) }
  }

  /// The staged recordings in `directory`, except `livePath` (the in-flight
  /// segment's file is not staged output yet). Oldest session first, and
  /// within one session the segments in order: part numbers are not
  /// fixed-width, so sorting by name would put `part-1000` before `part-999`.
  public static func listStaged(in directory: URL, excluding livePath: String?) throws
    -> [StagedRecordingFile]
  {
    let urls = try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    )
    let files: [StagedRecordingFile] = urls.compactMap { url in
      let path = url.standardizedFileURL.path
      guard path != livePath else { return nil }
      let modified =
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate ?? Date(timeIntervalSince1970: 0)
      return stagedInfo(path: path, modifiedMs: modified.timeIntervalSince1970 * 1000)
    }
    return files.sorted {
      ($0.sessionStartedMs, $0.part) < ($1.sessionStartedMs, $1.part)
    }
  }

  /// Resolve a caller-supplied path, refusing anything outside `directory`:
  /// the webview must not be able to read or delete arbitrary sandbox files.
  public static func stagedURL(for path: String, in directory: URL) throws -> URL {
    let directory = directory.standardizedFileURL
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard url.path.hasPrefix(directory.path + "/") else {
      throw NSError(
        domain: "app.reflect.recording", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "path is outside the recording staging directory"])
    }
    return url
  }
}
