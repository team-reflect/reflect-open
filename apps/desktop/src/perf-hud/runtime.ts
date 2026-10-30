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
  const state = {
    next: 0,
    count: 0,
    raf: 0,
    budgetMs: 1000 / 60,
    activePointers: 0,
    gestureStart: null as number | null,
    tail: undefined as ReturnType<typeof setTimeout> | undefined,
    pendingMoves: [] as number[],
    lags: [] as number[],
    results: [] as GestureMetrics[],
  }
  const view = createView()

  const getTimesSince = (from: number): number[] => {
    const result: number[] = []
    for (let i = 0; i < state.count; i++) {
      const time = times[(state.next - state.count + i + CAPACITY) % CAPACITY] ?? 0
      if (time >= from) {
        result.push(time)
      }
    }
    return result
  }

  const tick = (now: number): void => {
    times[state.next] = now
    state.next = (state.next + 1) % CAPACITY
    state.count = Math.min(state.count + 1, CAPACITY)
    if (state.pendingMoves.length > 0) {
      // The real start of this callback, after every queued move handler ran.
      const start = performance.now()
      for (const timeStamp of state.pendingMoves) {
        state.lags.push(Math.max(0, start - timeStamp))
      }
      state.pendingMoves.length = 0
    }
    state.raf = requestAnimationFrame(tick)
  }

  const finishGesture = (startMs: number, endMs: number): void => {
    const frameTimes = getTimesSince(startMs).filter((time) => time <= endMs)
    const result = measureGesture(frameTimes, state.lags, state.budgetMs)
    state.lags = []
    state.results = [...state.results, result].slice(-KEEP_GESTURES)
    view.root.dataset.gestures = JSON.stringify(state.results)
  }

  const handlePointerUp = (event: PointerEvent): void => {
    state.activePointers = Math.max(0, state.activePointers - 1)
    const startMs = state.gestureStart
    if (state.activePointers > 0 || startMs === null) {
      return
    }
    const endMs = event.timeStamp + SETTLE_TAIL_MS
    clearTimeout(state.tail)
    // 50 ms extra so the last frame of the tail is in the buffer.
    state.tail = setTimeout(() => {
      state.gestureStart = null
      finishGesture(startMs, endMs)
    }, SETTLE_TAIL_MS + 50)
  }

  const refresh = setInterval(() => {
    const lastSecond = getTimesSince(performance.now() - 1000)
    if (state.gestureStart === null && lastSecond.length > 1) {
      state.budgetMs = getPercentile(getFrameIntervals(lastSecond), 0.5)
    }
    view.render(Math.max(0, lastSecond.length - 1), state.budgetMs, state.results.at(-1))
  }, REFRESH_MS)

  const controller = new AbortController()
  // Capture runs before the app's handlers; passive never changes their behavior.
  const options = { capture: true, passive: true, signal: controller.signal }
  window.addEventListener(
    'pointerdown',
    (event) => {
      clearTimeout(state.tail)
      state.activePointers++
      state.gestureStart ??= event.timeStamp
    },
    options,
  )
  window.addEventListener(
    'pointermove',
    (event) => {
      if (state.activePointers > 0) {
        state.pendingMoves.push(event.timeStamp)
      }
    },
    options,
  )
  window.addEventListener('pointerup', handlePointerUp, options)
  window.addEventListener('pointercancel', handlePointerUp, options)
  document.body.append(view.root)
  state.raf = requestAnimationFrame(tick)

  return () => {
    controller.abort()
    cancelAnimationFrame(state.raf)
    clearInterval(refresh)
    clearTimeout(state.tail)
    view.root.remove()
  }
}

function createView(): {
  root: HTMLElement
  render: (fps: number, budgetMs: number, last: GestureMetrics | undefined) => void
} {
  const root = document.createElement('div')
  root.dataset.perfHud = ''
  root.dataset.gestures = '[]'
  root.className =
    'pointer-events-none fixed top-safe-offset-2 left-safe-offset-2 z-2147483647 h-10 w-60 rounded-lg bg-neutral-900/90 px-2 py-1 font-mono text-xs leading-4 whitespace-pre text-neutral-100 contain-strict will-change-transform'
  const live = document.createElement('div')
  const last = document.createElement('div')
  last.textContent = 'last  –'
  root.append(live, last)

  return {
    root,
    render: (fps, budgetMs, result) => {
      live.textContent = `MAIN ${String(fps).padStart(3)} fps   ${Math.round(1000 / budgetMs)}Hz`
      if (!result) {
        return
      }
      const ratio = result.hitchTimeRatio
      last.className =
        ratio < 5 ? 'text-green-400' : ratio <= 10 ? 'text-amber-400' : 'text-red-400'
      const lag = result.p95InputLagMs === null ? '–' : result.p95InputLagMs.toFixed(0)
      last.textContent = `last ${ratio.toFixed(0).padStart(2)} ms/s · p95 ${result.p95FrameMs.toFixed(0)} · lag ${lag}`
    },
  }
}
