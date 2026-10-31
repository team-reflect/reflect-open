/**
 * Outbound HTTP, in the shape of the global `fetch`.
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
