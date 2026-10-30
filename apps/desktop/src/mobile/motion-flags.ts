import { useCallback, useSyncExternalStore } from 'react'

export interface MotionFlagDefinition {
  /** The switch label in the Motion group of Settings. */
  label: string
  /** The value when neither the URL nor a stored choice sets one. */
  defaultValue: boolean
}

/**
 * Debug switches between a gesture's native-scroll implementation (`true`)
 * and the implementation it replaces (`false`). A migration adds its key; its
 * cleanup removes the key.
 */
export const MOTION_FLAGS = {} satisfies Record<string, MotionFlagDefinition>

export type MotionFlag = keyof typeof MOTION_FLAGS

export interface MotionFlagStore<Flag extends string> {
  get: (flag: Flag) => boolean
  set: (flag: Flag, value: boolean, options?: { persist?: boolean | undefined }) => void
  reset: () => void
  subscribe: (listener: () => void) => () => void
  list: () => { flag: Flag; label: string }[]
}

/**
 * A set of motion flags. A flag reads, in order: the URL
 * (`?motion=name:0,other:1`), the stored choices (JSON under `storageKey` in
 * `localStorage`), then its default.
 */
export function createMotionFlagStore<Flag extends string>(
  definitions: Readonly<Record<Flag, MotionFlagDefinition>>,
  { storageKey, search }: { storageKey: string; search: () => string },
): MotionFlagStore<Flag> {
  const isFlag = (name: string): name is Flag => Object.hasOwn(definitions, name)
  const listeners = new Set<() => void>()
  let choices: Partial<Record<Flag, boolean>> | undefined

  const readStored = (): Partial<Record<Flag, boolean>> => {
    const stored: Partial<Record<Flag, boolean>> = {}
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [name, value] of Object.entries(parsed)) {
          if (isFlag(name) && typeof value === 'boolean') {
            stored[name] = value
          }
        }
      }
    } catch {
      // Blocked or corrupt storage: the defaults apply.
    }
    return stored
  }
  const readUrl = (): Partial<Record<Flag, boolean>> => {
    const fromUrl: Partial<Record<Flag, boolean>> = {}
    for (const entry of new URLSearchParams(search()).get('motion')?.split(',') ?? []) {
      const [name = '', value] = entry.split(':')
      if (isFlag(name) && (value === '0' || value === '1')) {
        fromUrl[name] = value === '1'
      }
    }
    return fromUrl
  }
  // Read on first use, not at import, so importing the module touches no storage.
  const load = (): Partial<Record<Flag, boolean>> => {
    choices ??= { ...readStored(), ...readUrl() }
    return choices
  }
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    get: (flag) => load()[flag] ?? definitions[flag].defaultValue,
    set: (flag, value, options) => {
      load()[flag] = value
      if (options?.persist ?? false) {
        // Rewrites only registered keys, so keys of removed flags drop out.
        const stored = readStored()
        stored[flag] = value
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(stored))
        } catch {
          // Without storage the choice lasts until the page reloads.
        }
      }
      notify()
    },
    reset: () => {
      choices = {}
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    list: () => {
      return (Object.keys(definitions) as Flag[]).map((flag) => ({
        flag,
        label: definitions[flag].label,
      }))
    },
  }
}

const store = /* @__PURE__ */ createMotionFlagStore(MOTION_FLAGS, {
  storageKey: 'reflect:motion-flags',
  search: () => window.location.search,
})

export function getMotionFlag(flag: MotionFlag): boolean {
  return store.get(flag)
}

/** Switches `flag`. With `persist`, the choice lasts across launches. */
export function setMotionFlag(
  flag: MotionFlag,
  value: boolean,
  options?: { persist?: boolean | undefined },
): void {
  store.set(flag, value, options)
}

export function useMotionFlag(flag: MotionFlag): boolean {
  const read = useCallback((): boolean => store.get(flag), [flag])
  return useSyncExternalStore(store.subscribe, read, read)
}

/** Every registered flag with its label, in registry order. */
export function listMotionFlags(): { flag: MotionFlag; label: string }[] {
  return store.list()
}

/**
 * Puts every flag back to its default and forgets URL and stored choices
 * until the page reloads.
 */
export function resetMotionFlags(): void {
  store.reset()
}
