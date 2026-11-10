import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { HttpService } from '@reflect/core'

async function cancelUnreadBody(body: ReadableStream<Uint8Array>): Promise<void> {
  if (body.locked) {
    return
  }
  try {
    await body.cancel()
  } catch {
    // An errored body has nothing left to release.
  }
}

/**
 * The plugin keeps each response in the Rust resource table until its body
 * is read to the end or cancelled. Cancels the body of a response that was
 * garbage collected unread, e.g. after a `!response.ok` early return.
 */
const unreadBodies = new FinalizationRegistry<ReadableStream<Uint8Array>>((body) => {
  void cancelUnreadBody(body)
})

class TauriHttpServiceImpl implements HttpService {
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    if (!headers.has('Origin')) {
      headers.set('Origin', '')
    }
    const response = await tauriFetch(input, { ...init, headers })
    if (response.body !== null) {
      unreadBodies.register(response, response.body)
    }
    return response
  }
}

/**
 * HTTP through the Tauri HTTP plugin. Requests go out from the Rust side, so
 * webview CORS does not apply (OpenAI's API sends no CORS headers and would be
 * unreachable from the webview otherwise). The allowed hosts are scoped in
 * `src-tauri/capabilities/default.json`.
 *
 * The plugin stamps the webview's `Origin` (`tauri://localhost`) on every
 * request, which makes providers treat the app as a web page: Anthropic
 * answers any Origin-bearing request with a blanket 401 for organizations
 * with custom data-retention settings. The
 * `anthropic-dangerous-direct-browser-access` opt-in cannot override that
 * org policy, so keys from such orgs looked "rejected" on entry. These are
 * app to API calls, not page scripts, so send no Origin at all: an explicit
 * empty `Origin` tells the plugin to drop the header entirely (its
 * `unsafe-headers` feature, enabled in `src-tauri/Cargo.toml`, makes the
 * empty value an explicit removal).
 */
export function createTauriHttpService(): HttpService {
  return new TauriHttpServiceImpl()
}
