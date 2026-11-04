/**
 * Aborts when any of `signals` aborts, like `AbortSignal.any`. Each source
 * holds the result through its `abort` listener, so the result lives as long
 * as a source does. WebKit can collect an `AbortSignal.any` result that only
 * listener options hold, and those listeners then outlive the abort:
 * https://github.com/ocavuebot/webkit-abortsignal-any-gc
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason)
      break
    }
    source.addEventListener('abort', () => controller.abort(source.reason), {
      once: true,
      signal: controller.signal,
    })
  }
  return controller.signal
}
