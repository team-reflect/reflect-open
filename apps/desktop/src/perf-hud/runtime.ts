import {
  getFrameIntervals,
  getPercentile,
  measureGesture,
  type GestureMetrics,
} from '@/perf-hud/metrics.ts'

/** Covers the settle or dismiss animation after the finger lifts. */
const SETTLE_TAIL_MS = 500
const REFRESH_MS = 250
/** About 8 s at 120 Hz: longer than any gesture. */
const CAPACITY = 1024
/** `data-gestures` keeps this many results. */
const KEEP_GESTURES = 20

/**
 * Shows a main-thread frame meter and measures every pointer gesture. Each
 * result is appended to the `data-gestures` JSON of `[data-perf-hud]`.
 * Returns the function that removes the HUD.
 */
export function mountPerfHud(): () => void {
  const times = new Float64Array(CAPACITY)
  let next = 0
  let count = 0
  let raf = 0
  let budgetMs = 1000 / 60
  let activePointers = 0
  let gestureStart: number | null = null
  let tail: ReturnType<typeof setTimeout> | undefined
  const pendingMoves: number[] = []
  let lags: number[] = []
  let results: GestureMetrics[] = []
  const view = createView()

  const getTimesSince = (from: number): number[] => {
    const result: number[] = []
    for (let i = 0; i < count; i++) {
      const time = times[(next - count + i + CAPACITY) % CAPACITY] ?? 0
      if (time >= from) {
        result.push(time)
      }
    }
    return result
  }

  const tick = (now: number): void => {
    times[next] = now
    next = (next + 1) % CAPACITY
    count = Math.min(count + 1, CAPACITY)
    if (pendingMoves.length > 0) {
      // The real start of this callback, after every queued move handler ran.
      const start = performance.now()
      for (const timeStamp of pendingMoves) {
        lags.push(Math.max(0, start - timeStamp))
      }
      pendingMoves.length = 0
    }
    raf = requestAnimationFrame(tick)
  }

  const finishGesture = (startMs: number, endMs: number): void => {
    const frameTimes = getTimesSince(startMs).filter((time) => time <= endMs)
    const result = measureGesture(frameTimes, lags, budgetMs)
    lags = []
    results = [...results, result].slice(-KEEP_GESTURES)
    view.root.dataset.gestures = JSON.stringify(results)
  }

  const handlePointerUp = (event: PointerEvent): void => {
    activePointers = Math.max(0, activePointers - 1)
    const startMs = gestureStart
    if (activePointers > 0 || startMs === null) {
      return
    }
    const endMs = event.timeStamp + SETTLE_TAIL_MS
    clearTimeout(tail)
    // 50 ms extra so the last frame of the tail is in the buffer.
    tail = setTimeout(() => {
      gestureStart = null
      finishGesture(startMs, endMs)
    }, SETTLE_TAIL_MS + 50)
  }

  const refresh = setInterval(() => {
    const lastSecond = getTimesSince(performance.now() - 1000)
    if (gestureStart === null && lastSecond.length > 1) {
      budgetMs = getPercentile(getFrameIntervals(lastSecond), 0.5)
    }
    view.render(Math.max(0, lastSecond.length - 1), budgetMs, results.at(-1))
  }, REFRESH_MS)

  const controller = new AbortController()
  // Capture runs before the app's handlers; passive never changes their behavior.
  const options = { capture: true, passive: true, signal: controller.signal }
  window.addEventListener(
    'pointerdown',
    (event) => {
      clearTimeout(tail)
      activePointers++
      gestureStart ??= event.timeStamp
    },
    options,
  )
  window.addEventListener(
    'pointermove',
    (event) => {
      if (activePointers > 0) {
        pendingMoves.push(event.timeStamp)
      }
    },
    options,
  )
  window.addEventListener('pointerup', handlePointerUp, options)
  window.addEventListener('pointercancel', handlePointerUp, options)
  document.body.append(view.root)
  raf = requestAnimationFrame(tick)

  return () => {
    controller.abort()
    cancelAnimationFrame(raf)
    clearInterval(refresh)
    clearTimeout(tail)
    view.root.remove()
  }
}

const VALUE_CLASS = 'font-mono text-sm leading-5 font-semibold tabular-nums'

/** Green below `good`, amber up to `bad`, red above. */
function getToneClass(value: number, good: number, bad: number): string {
  return value < good ? 'text-green-400' : value <= bad ? 'text-amber-400' : 'text-red-400'
}

function createStat(label: string): { root: HTMLElement; value: HTMLElement; label: HTMLElement } {
  const root = document.createElement('div')
  const valueElement = document.createElement('div')
  const labelElement = document.createElement('div')
  valueElement.className = VALUE_CLASS
  valueElement.textContent = '–'
  labelElement.className = 'text-xs leading-4 whitespace-nowrap text-neutral-400'
  labelElement.textContent = label
  root.append(valueElement, labelElement)
  return { root, value: valueElement, label: labelElement }
}

function createView(): {
  root: HTMLElement
  render: (fps: number, budgetMs: number, last: GestureMetrics | undefined) => void
} {
  const root = document.createElement('div')
  root.dataset.perfHud = ''
  root.dataset.gestures = '[]'
  root.className =
    'pointer-events-none fixed top-safe-offset-2 left-safe-offset-2 z-2147483647 flex h-12 w-70 items-center gap-3 rounded-xl bg-neutral-900 px-3 text-neutral-100 shadow-lg ring-1 ring-white/10 contain-strict will-change-transform'
  const fps = createStat('fps')
  const divider = document.createElement('div')
  divider.className = 'h-7 w-px shrink-0 bg-white/20'
  const hitch = createStat('hitch ms/s')
  const p95 = createStat('p95 ms')
  const lag = createStat('lag ms')
  root.append(fps.root, divider, hitch.root, p95.root, lag.root)

  return {
    root,
    render: (liveFps, budgetMs, result) => {
      fps.value.textContent = String(liveFps)
      fps.label.textContent = `fps · ${Math.round(1000 / budgetMs)}Hz`
      if (!result) {
        return
      }
      hitch.value.textContent = result.hitchTimeRatio.toFixed(0)
      hitch.value.className = `${VALUE_CLASS} ${getToneClass(result.hitchTimeRatio, 5, 10)}`
      p95.value.textContent = result.p95FrameMs.toFixed(0)
      const lagMs = result.p95InputLagMs
      lag.value.textContent = lagMs === null ? '–' : lagMs.toFixed(0)
      lag.value.className =
        lagMs === null
          ? VALUE_CLASS
          : `${VALUE_CLASS} ${getToneClass(lagMs, result.frameBudgetMs, 2 * result.frameBudgetMs)}`
    },
  }
}
