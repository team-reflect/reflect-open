import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { hasBridge } from '@reflect/core'

/**
 * The transport for direct app → AI-provider calls (BYOK, Plan 10). Inside
 * the Tauri shell this is the HTTP plugin's fetch — requests go out from the
 * Rust side, so webview CORS doesn't apply (OpenAI's API sends no CORS
 * headers and would be unreachable from the webview otherwise). The allowed
 * hosts are scoped in `src-tauri/capabilities/default.json`. In plain-browser
 * dev there is no shell, so this falls back to the global fetch.
 */
export function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return hasBridge() ? tauriFetch(input, init) : fetch(input, init)
}
