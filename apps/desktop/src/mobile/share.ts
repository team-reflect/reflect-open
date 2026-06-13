import { splitFrontmatter } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Share a note through the OS share sheet (Plan 19, V1 parity) via the Web
 * Share API. The Tauri iOS WKWebView exposes a working `navigator.share`
 * (verified on-device), so no native plugin is needed — WebKit presents the
 * same `UIActivityViewController`.
 *
 * **Activation invariant:** `navigator.share` requires the tap's transient
 * user activation, which any `await` before the call consumes — so the
 * content must be read *synchronously*. The only synchronous source is the
 * open editor session's live buffer, which is also exactly what we want:
 * Share lives only on the note screen, where the note is open and its
 * debounced buffer holds the user's latest typing. `liveContent()` returns
 * that buffer once the session is ready (authoritative even when empty), or
 * `null` while it's still loading — a window not reachable via the menu in
 * practice, where we share empty rather than break activation with an async
 * disk read.
 *
 * Shares the markdown **body** (frontmatter stripped, so the recipient never
 * sees the `id:` block), with the title (the readable filename) as the
 * subject for targets that use one (Mail).
 */
export async function shareNote(path: string): Promise<void> {
  const live = openSession(path)?.liveContent() ?? ''
  const text = splitFrontmatter(live).body.trimStart()
  await navigator.share({ title: noteTitle(path), text })
}

/** The basename without its `.md` — the note's working title (Plan 17). */
function noteTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
