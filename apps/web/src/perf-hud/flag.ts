import { WritableStore } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'

const enabled = new WritableStore(false)
let unmount: (() => void) | null = null

async function mount(): Promise<void> {
  const { mountPerfHud } = await import('@/perf-hud/runtime.ts')
  // The switch may have turned off while the chunk was loading.
  if (enabled.get() && !unmount) {
    unmount = mountPerfHud()
  }
}

/** Turns the performance HUD on when the URL has `?perf`. Otherwise it loads nothing. */
export function startPerfHud(): void {
  if (new URLSearchParams(window.location.search).has('perf')) {
    setPerfHudEnabled(true)
  }
}

/** Shows or hides the HUD until the page reloads. */
export function setPerfHudEnabled(next: boolean): void {
  enabled.set(next)
  if (next) {
    void mount()
  } else {
    unmount?.()
    unmount = null
  }
}

export function usePerfHudEnabled(): boolean {
  return useStore(enabled)
}
