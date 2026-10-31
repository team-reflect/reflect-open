import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { HttpService } from '@reflect/core'

class TauriHttpServiceImpl implements HttpService {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    if (!headers.has('Origin')) {
      headers.set('Origin', '')
    }
    return tauriFetch(input, { ...init, headers })
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
