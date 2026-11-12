/**
 * Outbound HTTP, in the shape of the global `fetch`. Every host supports the
 * method, the headers, the body and the abort signal of a request, and the
 * status, the headers and the streamed body of a response. A host follows
 * redirects, and `Response.url` is not always the URL of the last hop.
 */
export interface HttpService {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

class BrowserHttpServiceImpl implements HttpService {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }
}

/**
 * HTTP backed by the platform's global `fetch`.
 */
export function createBrowserHttpService(): HttpService {
  return new BrowserHttpServiceImpl()
}
