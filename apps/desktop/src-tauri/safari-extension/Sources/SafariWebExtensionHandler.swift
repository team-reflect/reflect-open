import Foundation
import SafariServices

/// Safari's native-messaging endpoint for the Reflect Capture web extension.
/// Safari ignores the host name the extension passes to `sendNativeMessage`
/// and delivers every message to this handler, inside the app extension's
/// sandbox. The reply is the extension's ack (`captureAckSchema` in
/// `packages/core/src/capture/capture-envelope.ts`).
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: CaptureSpool.spool(request?.userInfo?[SFExtensionMessageKey])]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
