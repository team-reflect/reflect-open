import type { HttpService } from '@reflect/core'

const HTTP_URL = 'reflect-app://localhost/__http'

/**
 * HTTP through the Swift shell's `reflect-app://localhost/__http?url=<target>`
 * route. The shell sends the request from native code, so webview CORS does
 * not apply, and streams the response body back. Aborting the request's
 * signal cancels the native request.
 */
export function createSwiftHttpService(fetchFn: typeof fetch): HttpService {
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      return await fetchFn(`${HTTP_URL}?url=${encodeURIComponent(request.url)}`, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? null : await request.arrayBuffer(),
        signal: request.signal,
      })
    },
  }
}
