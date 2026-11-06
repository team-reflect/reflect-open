/* eslint-disable no-console */
/**
 * Diagnostic ring log for the day carousel swipe jitter. Throwaway: this file
 * and its call sites live only on the `ocavue/swipe-log` branch.
 *
 * Under the Vite dev server every entry is POSTed to `/__swipe-log`, which the
 * `swipe-log` plugin in `vite.config.ts` prints to the terminal (no Web
 * Inspector needed, and no dependency on the HMR websocket).
 *
 * In the Web Inspector console:
 *   __swipeLog.dump()            prints and returns the last 400 entries
 *   __swipeLog.dump(0)           every entry (up to 8000)
 *   __swipeLog.clear()
 *   __swipeLog.state.live = true logs every entry to the console as well
 *   __swipeLog.state.noPullback = true   turns the per-scroll pullback off
 * `localStorage.swipeLogLive = '1'` and `localStorage.swipeLogNoPullback = '1'`
 * set the flags at startup; `?nopullback=1` in the page URL does the same for
 * the pullback switch. A pullback write while a finger is down, or within
 * 1.5 s of the last touch event, prints a `!!!!` line.
 */

export interface SwipeLogEntry {
  t: number
  kind: string
  data: Record<string, unknown>
}

const MAX_ENTRIES = 8000
const TRIM_TO = 7000
const WARN_COOLDOWN_MS = 3000
const RECENT_TOUCH_MS = 1500

const entries: SwipeLogEntry[] = []
let lastTouchAt = -Infinity
let lastWarnAt = -Infinity
let seq = 0

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function readQueryFlag(key: string): boolean {
  try {
    return new URLSearchParams(location.search).get(key) === '1'
  } catch {
    return false
  }
}

export const swipeLogState = {
  live: readFlag('swipeLogLive'),
  noPullback: readFlag('swipeLogNoPullback') || readQueryFlag('nopullback'),
  // Experiments: `?nosnapstop=1` drops `snap-always` from the day cells;
  // `?lazymount=1` mounts the next day only at the settle, not mid-gesture.
  noSnapStop: readQueryFlag('nosnapstop'),
  lazyMount: readQueryFlag('lazymount'),
  // Stream entries to the Vite terminal.
  remote: import.meta.env.DEV,
}

const REMOTE_FLUSH_MS = 200
const REMOTE_ENDPOINT = '/__swipe-log'
let remoteQueue: string[] = []
let remoteTimer: ReturnType<typeof setTimeout> | undefined

async function flushRemote(): Promise<void> {
  remoteTimer = undefined
  if (remoteQueue.length === 0) {
    return
  }
  const body = remoteQueue.join('\n')
  remoteQueue = []
  try {
    await fetch(REMOTE_ENDPOINT, { method: 'POST', body, keepalive: true })
  } catch {
    // The dev server is gone; keep the ring buffer.
  }
}

function sendRemote(line: string): void {
  if (!swipeLogState.remote) {
    return
  }
  remoteQueue.push(line)
  remoteTimer ??= setTimeout(() => void flushRemote(), REMOTE_FLUSH_MS)
}

function round(value: unknown): unknown {
  return typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(1)) : value
}

function formatEntry(entry: SwipeLogEntry): string {
  const fields = Object.entries(entry.data)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? value : JSON.stringify(round(value))}`,
    )
    .join(' ')
  return `${entry.t.toFixed(1).padStart(10)} ${entry.kind.padEnd(16)} ${fields}`
}

/**
 * Records one entry. `data` values are plain numbers, strings, or booleans.
 */
export function swipeLog(kind: string, data: Record<string, unknown> = {}): void {
  const entry: SwipeLogEntry = { t: performance.now(), kind, data: { n: seq++, ...data } }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - TRIM_TO)
  }
  const line = formatEntry(entry)
  sendRemote(line)
  if (swipeLogState.live) {
    console.log('[swipe-log]', line)
  }
}

/**
 * A short, stable description of a DOM node for the log.
 */
export function describeNode(node: EventTarget | null | undefined): string {
  if (!(node instanceof Element)) {
    return node === document ? 'document' : node === window ? 'window' : String(node)
  }
  const day = node.closest('[data-day]')?.getAttribute('data-day')
  const classes = Array.from(node.classList).slice(0, 3).join('.')
  const editable = node.closest('[contenteditable]') ? ' ce' : ''
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes ? `.${classes}` : ''}${day ? `@${day}` : ''}${editable}`
}

/**
 * Prints the last `count` entries (0 for all) and returns them as text.
 */
export function dumpSwipeLog(count = 400): string {
  const slice = count > 0 ? entries.slice(-count) : entries
  const header = `[swipe-log] ${slice.length}/${entries.length} entries, now=${performance.now().toFixed(1)}, ua=${navigator.userAgent}`
  const text = [header, ...slice.map(formatEntry)].join('\n')
  console.log(text)
  return text
}

/**
 * Marks that a touch event happened, for the pullback-during-touch warning.
 */
export function noteTouch(): void {
  lastTouchAt = performance.now()
}

/**
 * Warns (with a dump) when a pullback write lands while a finger may be down.
 */
export function warnIfPullbackDuringTouch(fingersDown: number): void {
  const now = performance.now()
  const recentTouch = now - lastTouchAt < RECENT_TOUCH_MS
  if (fingersDown === 0 && !recentTouch) {
    return
  }
  swipeLog('WARN', { fingersDown, sinceTouch: now - lastTouchAt })
  if (now - lastWarnAt < WARN_COOLDOWN_MS) {
    return
  }
  lastWarnAt = now
  const line = `!!!! pullback write while fingersDown=${fingersDown}, ${(now - lastTouchAt).toFixed(0)} ms after the last touch event`
  sendRemote(line)
  console.log(`[swipe-log] ${line}`)
  if (!swipeLogState.remote) {
    dumpSwipeLog(300)
  }
}

let installed = false

// The call site that owns the next scroll write (`restOn`), so its `js:*`
// entry names it instead of carrying a stack.
let currentSite: string | undefined

/**
 * Runs `write` with its `js:*` log entries attributed to `site`.
 */
export function withSite<T>(site: string, write: () => T): T {
  const previous = currentSite
  currentSite = site
  try {
    return write()
  } finally {
    currentSite = previous
  }
}

function stack(): string {
  const lines = (new Error().stack ?? '').split('\n')
  return lines
    .slice(2, 8)
    .map((line) =>
      line
        .trim()
        .replace(/^at /, '')
        .replace(/https?:\/\/[^/]+/, ''),
    )
    .join(' | ')
    .slice(0, 500)
}

function origin(): Record<string, unknown> {
  return currentSite ? { site: currentSite } : { stack: stack() }
}

/**
 * Logs every JS write to the scroller's horizontal position: the `scrollLeft`
 * setter on the element, `scrollTo` / `scroll` / `scrollBy` on it, and
 * `scrollIntoView` / `focus` on anything inside it (both can scroll ancestors).
 */
function watchScrollWrites(scroller: HTMLElement): void {
  const left = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
  if (left?.get && left.set) {
    const { get, set } = left
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get() {
        return get.call(this) as number
      },
      set(value: number) {
        swipeLog('js:scrollLeft=', { value, from: get.call(this), ...origin() })
        set.call(this, value)
      },
    })
  }
  for (const name of ['scrollTo', 'scroll', 'scrollBy'] as const) {
    const original = Element.prototype[name] as (...args: unknown[]) => void
    Element.prototype[name] = function patched(this: Element, ...args: unknown[]) {
      if (this === scroller) {
        const [first, second] = args
        const options =
          typeof first === 'object' && first !== null
            ? (first as ScrollToOptions)
            : { left: first as number, top: second as number }
        swipeLog(`js:${name}`, {
          left: options.left,
          top: options.top,
          behavior: options.behavior,
          from: scroller.scrollLeft,
          ...origin(),
        })
      }
      return original.apply(this, args)
    } as typeof original
  }
  const scrollIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function patched(this: Element, arg?: unknown) {
    if (scroller.contains(this)) {
      swipeLog('js:scrollIntoView', {
        target: describeNode(this),
        arg: typeof arg === 'object' ? JSON.stringify(arg) : String(arg),
        from: scroller.scrollLeft,
        ...origin(),
      })
    }
    return scrollIntoView.call(this, arg as boolean | ScrollIntoViewOptions | undefined)
  }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function patched(this: HTMLElement, options?: FocusOptions) {
    if (scroller.contains(this)) {
      swipeLog('js:focus', {
        target: describeNode(this),
        preventScroll: options?.preventScroll ?? false,
        from: scroller.scrollLeft,
        ...origin(),
      })
    }
    return focus.call(this, options)
  }
}

/**
 * Logs DOM changes near the top of the scroller (cells, slides, and their
 * first levels), which can move a snapping scroller on iOS.
 */
function watchMutations(scroller: HTMLElement): void {
  const depthOf = (node: Node): number => {
    let depth = 0
    for (
      let current: Node | null = node;
      current && current !== scroller;
      current = current.parentNode
    ) {
      depth += 1
    }
    return depth
  }
  const observer = new MutationObserver((records) => {
    const summary: string[] = []
    let skipped = 0
    for (const record of records) {
      if (depthOf(record.target) > 4) {
        skipped += 1
        continue
      }
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          summary.push(`+${describeNode(node)}`)
        }
        for (const node of record.removedNodes) {
          summary.push(`-${describeNode(node)}`)
        }
      } else {
        summary.push(
          `${describeNode(record.target)}[${record.attributeName}]=${(record.target as Element).getAttribute(record.attributeName ?? '') ?? 'null'}`,
        )
      }
    }
    if (summary.length === 0) {
      return
    }
    swipeLog('dom', {
      sl: scroller.scrollLeft,
      n: summary.length,
      deep: skipped,
      changes: summary.slice(0, 6).join(' '),
    })
  })
  observer.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'inert', 'hidden'],
  })
}

/**
 * Document-level touch, focus, and viewport logging, installed once. These
 * listeners see touches that never reach the scroller, so a `doc:touchstart`
 * with no `ts:touchstart` after it means the scroller's listener missed it.
 */
export function installSwipeLog(scroller: HTMLElement): void {
  if (installed) {
    return
  }
  installed = true
  const globals = globalThis as unknown as Record<string, unknown>
  globals.__swipeLog = {
    dump: dumpSwipeLog,
    clear: () => entries.splice(0, entries.length),
    state: swipeLogState,
    entries,
  }
  const starts = new Map<number, { x: number; y: number }>()
  const onTouch = (event: TouchEvent): void => {
    noteTouch()
    const touch = event.changedTouches[0]
    if (!touch) {
      return
    }
    const target = event.target
    const start = starts.get(touch.identifier)
    if (event.type === 'touchstart') {
      starts.set(touch.identifier, { x: touch.clientX, y: touch.clientY })
    } else if (event.type !== 'touchmove') {
      starts.delete(touch.identifier)
    }
    swipeLog(`doc:${event.type}`, {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      dx: start ? touch.clientX - start.x : 0,
      dy: start ? touch.clientY - start.y : 0,
      touches: event.touches.length,
      target: describeNode(target),
      inScroller: target instanceof Node && scroller.contains(target),
      sl: scroller.scrollLeft,
    })
  }
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    document.addEventListener(type, onTouch, { capture: true, passive: true })
  }
  const onFocus = (event: FocusEvent): void => {
    swipeLog(`doc:${event.type}`, {
      target: describeNode(event.target),
      active: describeNode(document.activeElement),
    })
  }
  document.addEventListener('focusin', onFocus, { capture: true })
  document.addEventListener('focusout', onFocus, { capture: true })
  const viewport = window.visualViewport
  const onViewport = (event: Event): void => {
    swipeLog(`vv:${event.type}`, {
      h: viewport?.height,
      top: viewport?.offsetTop,
      scale: viewport?.scale,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
    })
  }
  viewport?.addEventListener('resize', onViewport)
  viewport?.addEventListener('scroll', onViewport)
  window.addEventListener('orientationchange', onViewport)
  document.addEventListener('visibilitychange', () => {
    swipeLog('doc:visibility', { state: document.visibilityState })
  })
  watchScrollWrites(scroller)
  watchMutations(scroller)
  swipeLog('install', {
    query: location.search || '(none)',
    ua: navigator.userAgent,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    width: scroller.getBoundingClientRect().width,
    live: swipeLogState.live,
    noPullback: swipeLogState.noPullback,
    noSnapStop: swipeLogState.noSnapStop,
    lazyMount: swipeLogState.lazyMount,
  })
  console.info(
    '[swipe-log] installed. __swipeLog.dump() prints the last 400 entries; __swipeLog.state.live = true streams them; __swipeLog.state.noPullback = true disables the per-scroll pullback.',
  )
}
