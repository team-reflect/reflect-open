/**
 * Make virtua usable under jsdom, which computes no layout. virtua measures the
 * viewport and every row through `ResizeObserver` `contentRect`, and ignores any
 * entry whose `offsetParent` is null. jsdom supplies neither, so without this a
 * virtua list renders zero rows.
 *
 * Installs a `ResizeObserver` that reports `sizeOf(element)` for each observed
 * element (asynchronously, like a real one, so it never re-enters React's render)
 * and a truthy `offsetParent`. vitest isolates globals per test file, so there is
 * nothing to tear down.
 */
export function installVirtuaTestEnv(sizeOf: (element: HTMLElement) => number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return document.body
    },
  })

  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: Element): void {
      const size = sizeOf(element as HTMLElement)
      const rect = { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0 }
      const entry = { target: element, contentRect: { ...rect, toJSON: () => rect } } as ResizeObserverEntry
      queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver))
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
}
