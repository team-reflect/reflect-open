import { useSyncExternalStore } from 'react'
import { WritableStore } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'

/**
 * Where the shell draws the tab capsule and the `+`: a capsule and `+` on one
 * line at the bottom (`bar`), a column at the trailing edge with `+` above a
 * vertical capsule (`rail`, the iPhone Duo), or the capsule at the top and `+`
 * in the bottom-right corner (`pad`).
 */
export type MobileForm = 'bar' | 'rail' | 'pad'

/**
 * A form that the Debug settings pin, or `auto` to follow the window width.
 */
export type MobileFormOverride = MobileForm | 'auto'

const PAD_QUERY = '(min-width: 768px)'

/**
 * Reads `?mobile-form=bar|rail|pad`. A web page cannot tell an iPhone Duo
 * from an iPhone, so the rail shows only when pinned.
 */
function readUrlOverride(): MobileFormOverride {
  const value = new URLSearchParams(window.location.search).get('mobile-form')
  return value === 'bar' || value === 'rail' || value === 'pad' ? value : 'auto'
}

const override = new WritableStore<MobileFormOverride>(readUrlOverride())

/**
 * Pins the form until the page reloads.
 */
export function setMobileFormOverride(next: MobileFormOverride): void {
  override.set(next)
}

export function useMobileFormOverride(): MobileFormOverride {
  return useStore(override)
}

function subscribePad(listener: () => void): () => void {
  const query = window.matchMedia(PAD_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

function readPad(): boolean {
  return window.matchMedia(PAD_QUERY).matches
}

/**
 * The form of the shell's bottom chrome: the pinned one, else `pad` in a
 * window at least 768 px wide and `bar` in a narrower one.
 */
export function useMobileForm(): MobileForm {
  const pinned = useStore(override)
  const pad = useSyncExternalStore(subscribePad, readPad)
  if (pinned !== 'auto') {
    return pinned
  }
  return pad ? 'pad' : 'bar'
}
