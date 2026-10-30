import { useSyncExternalStore } from 'react'
import type { LoggerService, StorageService } from '@reflect/core'

const STORAGE_KEY = 'reflect.perfHud'

const state = {
  store: null as StorageService['local'] | null,
  logger: null as LoggerService | null,
  enabled: false,
  unmount: null as (() => void) | null,
  listeners: new Set<() => void>(),
}

async function mount(): Promise<void> {
  try {
    const { mountPerfHud } = await import('@/perf-hud/runtime.ts')
    // The switch may have turned off while the chunk was loading.
    if (state.enabled && !state.unmount) {
      state.unmount = mountPerfHud()
    }
  } catch (error) {
    state.logger?.error('loading the performance HUD failed', error)
  }
}

function apply(enabled: boolean): void {
  state.enabled = enabled
  if (enabled) {
    void mount()
  } else {
    state.unmount?.()
    state.unmount = null
  }
  for (const listener of state.listeners) {
    listener()
  }
}

/**
 * Turns the performance HUD on when `localStorage` says so, or for this page
 * load only when the URL has `?perf`. Otherwise it loads nothing.
 */
export function startPerfHud(services: { storage: StorageService; logger: LoggerService }): void {
  state.store = services.storage.local
  state.logger = services.logger
  const fromQuery = new URLSearchParams(window.location.search).has('perf')
  if (fromQuery || state.store.get(STORAGE_KEY) === '1') {
    apply(true)
  }
}

export function setPerfHudEnabled(enabled: boolean): void {
  state.store?.set(STORAGE_KEY, enabled ? '1' : null)
  apply(enabled)
}

function subscribe(listener: () => void): () => void {
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

function getEnabled(): boolean {
  return state.enabled
}

export function usePerfHudEnabled(): boolean {
  return useSyncExternalStore(subscribe, getEnabled, getEnabled)
}
