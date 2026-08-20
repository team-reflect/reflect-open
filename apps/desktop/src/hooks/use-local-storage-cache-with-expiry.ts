import { useCallback, useEffect, useMemo, useState } from 'react'
import { z, type ZodType } from 'zod'
import { useLocalStorageCache } from '@/hooks/use-local-storage-cache'

/** Namespaces the entries that carry a shelf life. */
const EXPIRY_KEY_PREFIX = '__expiry__'

/** How long after a value falls due the hook looks again. */
const CHECK_TIME_DELAY = 10_000

/**
 * A localStorage cache with a shelf life: the value is stored next to the
 * time it was written, and once it is older than `maxAgeMs` it reads as
 * `null`, as if nothing were stored.
 *
 * Age is measured against a `checkTime` a timer refreshes, not against a
 * live clock: reading the clock during render is impure, and a value that
 * fell due between two renders would otherwise vanish on whichever unrelated
 * render came next.
 */
export function useLocalStorageCacheWithExpiry<T>(
  key: string,
  schema: ZodType<T, unknown>,
  maxAgeMs: number,
): [value: T | null, setValue: (value: T | null) => void] {
  const envelopeSchema = useMemo(() => z.object({ value: schema, updatedAt: z.number() }), [schema])
  const [envelope, setEnvelope] = useLocalStorageCache(EXPIRY_KEY_PREFIX + key, envelopeSchema)
  const [checkTime, setCheckTime] = useState(() => Date.now())

  const value = useMemo(() => {
    if (envelope === null) {
      return null
    }
    const isExpired = checkTime - envelope.updatedAt > maxAgeMs
    return isExpired ? null : envelope.value
  }, [checkTime, envelope, maxAgeMs])

  const setValue = useCallback(
    (next: T | null) => {
      setEnvelope(next === null ? null : { value: next, updatedAt: Date.now() })
    },
    [setEnvelope],
  )

  // One timer per stored value, landing just after it falls due.
  const expiresAt = envelope === null ? null : envelope.updatedAt + maxAgeMs
  useEffect(() => {
    if (expiresAt === null) {
      return
    }
    const nextCheckTime = Math.max(0, expiresAt - Date.now()) + CHECK_TIME_DELAY
    const timer = setTimeout(() => {
      setCheckTime(Date.now())
    }, nextCheckTime)
    return () => {
      clearTimeout(timer)
    }
  }, [expiresAt])

  return [value, setValue]
}
