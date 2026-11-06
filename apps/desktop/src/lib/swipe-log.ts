/* eslint-disable no-console */
/**
 * Diagnostic ring log for the day carousel swipe jitter. Throwaway: this file
 * and its call sites live only on the `ocavue/swipe-log` branch.
 *
 * In the Web Inspector console:
 *   __swipeLog.dump()            prints and returns the last 400 entries
 *   __swipeLog.dump(0)           every entry (up to 8000)
 *   __swipeLog.clear()
 *   __swipeLog.state.live = true logs every entry as it happens
 *   __swipeLog.state.noPullback = true   turns the per-scroll pullback off
 * `localStorage.swipeLogLive = '1'` and `localStorage.swipeLogNoPullback = '1'`
 * set the flags at startup. A pullback write while a finger is down, or
 * within 1.5 s of the last touch event, prints a `!!!!` line with a dump.
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

export const swipeLogState = {
  live: readFlag('swipeLogLive'),
  noPullback: readFlag('swipeLogNoPullback'),
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
  if (swipeLogState.live) {
    console.log('[swipe-log]', formatEntry(entry))
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
  console.log(
    `[swipe-log] !!!! pullback write while fingersDown=${fingersDown}, ${(now - lastTouchAt).toFixed(0)} ms after the last touch event. Last 300 entries follow; run __swipeLog.dump(0) for all.`,
  )
  dumpSwipeLog(300)
}

let installed = false

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
  swipeLog('install', {
    ua: navigator.userAgent,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    width: scroller.getBoundingClientRect().width,
    live: swipeLogState.live,
    noPullback: swipeLogState.noPullback,
  })
  console.info(
    '[swipe-log] installed. __swipeLog.dump() prints the last 400 entries; __swipeLog.state.live = true streams them; __swipeLog.state.noPullback = true disables the per-scroll pullback.',
  )
}
