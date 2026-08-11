import Foundation
import UniformTypeIdentifiers

/// What one share-sheet invocation extracted, ready to spool.
enum SharedCapture {
    /// A web page or URL — from Safari's JS preprocessor (rich: title,
    /// selection, meta description) or a bare URL item (title best-effort
    /// from a plain-text sibling, the way Chrome shares).
    case link(url: String, title: String, selection: String?, metaDescription: String?)
    /// Non-URL text: becomes a bullet on today's daily note.
    case text(String)
}

enum ShareStatus {
    case saving
    case saved
    case failed
}

/// The extension's one flow: extract the shared item, spool an envelope into
/// the App Group inbox, report. Entirely offline — saving never waits on the
/// network, which is the point of the envelope model (the main app relays,
/// drains, and enriches later; see `docs/porting/reflect-mobile/share-extension.md`).
final class ShareState: ObservableObject {
    @Published var status = ShareStatus.saving

    var extensionContext: NSExtensionContext?

    /// Single-flight: SwiftUI can fire `onAppear` more than once, and a
    /// second pass would mint a fresh envelope id — a duplicate capture.
    /// (The drain would dedup an identical re-share anyway, but the spool
    /// should never carry one in the first place.)
    private var started = false

    /// How long the "Saved" confirmation stays up before the sheet dismisses
    /// itself — long enough to read, short enough to keep the flow two-tap.
    private static let dismissDelay: TimeInterval = 0.9

    func save() {
        guard !started else {
            return
        }
        started = true
        guard let context = extensionContext else {
            return update(.failed)
        }
        Self.extract(from: context) { [weak self] capture in
            guard let self else {
                return
            }
            guard let capture else {
                return self.update(.failed)
            }
            self.spool(capture)
        }
    }

    func dismiss() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    private func spool(_ capture: SharedCapture) {
        do {
            switch capture {
            case let .link(url, title, selection, metaDescription):
                try CaptureInbox.spoolLink(
                    url: url,
                    title: title,
                    selection: selection,
                    metaDescription: metaDescription
                )
            case let .text(text):
                guard try CaptureInbox.spoolText(text, source: "ios-share") else {
                    return update(.failed) // nothing printable to save
                }
            }
            update(.saved)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.dismissDelay) { [weak self] in
                self?.dismiss()
            }
        } catch {
            update(.failed)
        }
    }

    private func update(_ status: ShareStatus) {
        DispatchQueue.main.async {
            self.status = status
        }
    }

    // MARK: - extraction

    /// Pull the shared content out of the extension context. Provider load
    /// callbacks arrive on arbitrary queues; `completion` may too.
    private static func extract(
        from context: NSExtensionContext,
        completion: @escaping (SharedCapture?) -> Void
    ) {
        let attachments = context.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] }
        guard !attachments.isEmpty else {
            return completion(nil)
        }

        // Safari web pages: the JS preprocessor's property-list results carry
        // the richest capture (title, selection, meta description).
        if let provider = first(of: attachments, conformingTo: UTType.propertyList.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) {
                item, _ in
                if let capture = pageCapture(from: item) {
                    completion(capture)
                } else {
                    // Malformed preprocessing results must not fail a share
                    // that also carries a plain URL or text attachment.
                    extractPlain(from: attachments, completion: completion)
                }
            }
            return
        }
        extractPlain(from: attachments, completion: completion)
    }

    /// The non-Safari extraction paths: a URL attachment (title best-effort
    /// from a plain-text sibling), else plain text.
    private static func extractPlain(
        from attachments: [NSItemProvider],
        completion: @escaping (SharedCapture?) -> Void
    ) {
        // A URL item; Chrome and friends share the page title as a separate
        // plain-text attachment (why the activation rule needs dictionary
        // version 2), so read it best-effort.
        if let provider = first(of: attachments, conformingTo: UTType.url.identifier) {
            let titleProvider = attachments.first {
                $0 !== provider && $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
            }
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                guard let url = sharedUrlString(item) else {
                    return completion(nil)
                }
                guard CaptureInbox.isHttpUrl(url) else {
                    // Not a web page (mailto:, an app URL): keep it as text
                    // rather than dropping the share.
                    return completion(.text(url))
                }
                guard let titleProvider else {
                    return completion(.link(url: url, title: "", selection: nil, metaDescription: nil))
                }
                titleProvider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) {
                    titleItem, _ in
                    let title = titleItem as? String ?? ""
                    completion(.link(url: url, title: title, selection: nil, metaDescription: nil))
                }
            }
            return
        }

        // Plain text: a pasted URL saves as a link, anything else as a bullet.
        if let provider = first(of: attachments, conformingTo: UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) {
                item, _ in
                guard let text = item as? String else {
                    return completion(nil)
                }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if CaptureInbox.isHttpUrl(trimmed), !trimmed.contains(" "),
                    URL(string: trimmed) != nil
                {
                    completion(.link(url: trimmed, title: "", selection: nil, metaDescription: nil))
                } else {
                    completion(.text(text))
                }
            }
            return
        }

        completion(nil)
    }

    private static func first(
        of attachments: [NSItemProvider],
        conformingTo identifier: String
    ) -> NSItemProvider? {
        attachments.first { $0.hasItemConformingToTypeIdentifier(identifier) }
    }

    private static func sharedUrlString(_ item: NSSecureCoding?) -> String? {
        if let url = item as? URL {
            return url.absoluteString
        }
        if let url = item as? NSURL {
            return url.absoluteString
        }
        return nil
    }

    /// Decode the JS preprocessor's results. `nil` for a malformed dictionary
    /// (or a page the preprocessor couldn't run on) — the caller then falls
    /// back to the plain URL/text attachments instead of failing the share.
    private static func pageCapture(from item: NSSecureCoding?) -> SharedCapture? {
        guard
            let dict = item as? NSDictionary,
            let results = dict[NSExtensionJavaScriptPreprocessingResultsKey] as? NSDictionary,
            let url = results["url"] as? String,
            CaptureInbox.isHttpUrl(url)
        else {
            return nil
        }
        return .link(
            url: url,
            title: results["title"] as? String ?? "",
            selection: results["selection"] as? String,
            metaDescription: results["description"] as? String
        )
    }
}
