import { useSyncExternalStore } from 'react'

let enabled = false
let unmount: (() => void) | null = null
const listeners = new Set<() => void>()

async function mount(): Promise<void> {
  const { mountPerfHud } = await import('@/perf-hud/runtime.ts')
  // The switch may have turned off while the chunk was loading.
  if (enabled && !unmount) {
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
  enabled = next
  if (next) {
    void mount()
  } else {
    unmount?.()
    unmount = null
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getEnabled(): boolean {
  return enabled
}

export function usePerfHudEnabled(): boolean {
  return useSyncExternalStore(subscribe, getEnabled, getEnabled)
}
