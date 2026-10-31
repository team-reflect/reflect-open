import type { ShareService } from '@reflect/app'

/**
 * Share a note through the OS share sheet (Plan 19, V1 parity) via the Web
 * Share API. The Tauri iOS WKWebView exposes a working `navigator.share`
 * (verified on-device), so no native plugin is needed — WebKit presents the
 * same `UIActivityViewController`.
 *
 * **Activation invariant:** `navigator.share` requires the tap's transient
 * user activation, which any `await` before the call consumes — so the
 * content must be read *synchronously*: `ShareService.noteContent` reads the
 * open editor session's live buffer. Share lives only on the note screen,
 * where the note is open and its debounced buffer holds the user's latest
 * typing.
 */
export async function shareNote(share: ShareService, path: string): Promise<void> {
  await navigator.share(share.noteContent(path))
}
