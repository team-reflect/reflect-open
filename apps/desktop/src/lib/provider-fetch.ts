import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { hasBridge } from '@reflect/core'

/**
 * The transport for direct app → AI-provider calls (BYOK, Plan 10). Inside
 * the Tauri shell this is the HTTP plugin's fetch — requests go out from the
 * Rust side, so webview CORS doesn't apply (OpenAI's API sends no CORS
 * headers and would be unreachable from the webview otherwise). The allowed
 * hosts are scoped in `src-tauri/capabilities/default.json`. In plain-browser
 * dev there is no shell, so this falls back to the global fetch.
 *
 * The plugin stamps the webview's `Origin` (`tauri://localhost`) on every
 * request, which makes providers treat the app as a web page: Anthropic
 * answers any Origin-bearing request with a blanket 401 for organizations
 * with custom data-retention settings — the
 * `anthropic-dangerous-direct-browser-access` opt-in cannot override that
 * org policy, so keys from such orgs looked "rejected" on entry. These are
 * app → API calls, not page scripts, so send no Origin at all: an explicit
 * empty `Origin` tells the plugin to drop the header entirely (its
 * `unsafe-headers` feature, enabled in `src-tauri/Cargo.toml`, makes the
 * empty value an explicit removal).
 */
export function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!hasBridge()) {
    return fetch(input, init)
  }
  const headers = new Headers(init?.headers)
  if (!headers.has('Origin')) {
    headers.set('Origin', '')
  }
  return tauriFetch(input, { ...init, headers })
}
