import type { ZodType } from 'zod'

/** Shared primitive for a subscribable browser-storage key. */

/**
 * One key's value, held in memory and published to subscribers. The store
 * assumes it is the only writer of its key, and treats every failure storage
 * can produce as "nothing stored".
 */
export class StorageStore {
  private readonly key: string
  private readonly storage: Storage | null
  /** The last known value; `undefined` until storage has been read once. */
  private cachedValue: string | null | undefined = undefined
  private readonly listeners = new Set<() => void>()

  constructor(key: string, storage?: Storage | null) {
    this.key = key
    this.storage = storage ?? null
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get = (): string | null => {
    if (this.cachedValue === undefined) {
      try {
        this.cachedValue = this.storage?.getItem(this.key) ?? null
      } catch (error) {
        console.error('reading storage failed', this.key, error)
        this.cachedValue = null
      }
    }
    return this.cachedValue
  }

  getJson = <T>(schema: ZodType<T>): T | undefined => {
    try {
      const value: unknown = JSON.parse(this.get() ?? '')
      const result = schema.safeParse(value)
      return result.success ? result.data : undefined
    } catch {
      return undefined
    }
  }

  set = (value: string | null): void => {
    if (this.get() === value) {
      return
    }
    this.cachedValue = value
    try {
      if (value === null) {
        this.storage?.removeItem(this.key)
      } else {
        this.storage?.setItem(this.key, value)
      }
    } catch (error) {
      console.error('writing storage failed', this.key, error)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  setJson = <T>(schema: ZodType<T>, value: T): void => {
    const result = schema.safeParse(value)
    if (result.success) {
      this.set(JSON.stringify(result.data))
    }
  }
}
