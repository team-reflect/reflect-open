import { useCallback, useMemo } from 'react'
import type { ZodType } from 'zod'
import { useLocalStorageExternalStore } from '@/hooks/use-local-storage-external-store'

/** Namespaces this app's entries. */
export const CACHE_KEY_PREFIX = '__reflect__'

/**
 * A JSON value in localStorage, validated by `schema` on the way in and on
 * the way out. A missing, unreadable, unparsable, or schema-invalid entry
 * reads as `null`; passing `null` to the setter removes it.
 *
 * `schema` must keep its identity across renders (a module-level schema).
 */
export function useLocalStorageCache<T>(
  key: string,
  schema: ZodType<T, unknown>,
): [value: T | null, setValue: (value: T | null) => void] {
  const [rawValue, setRawValue] = useLocalStorageExternalStore(CACHE_KEY_PREFIX + key)

  const value = useMemo(() => {
    if (rawValue === null) {
      return null
    }
    try {
      const parsed = schema.safeParse(JSON.parse(rawValue))
      return parsed.success ? parsed.data : null
    } catch {
      return null // not JSON at all
    }
  }, [rawValue, schema])

  const setValue = useCallback(
    (next: T | null) => {
      if (next === null) {
        setRawValue(null)
        return
      }
      // A value the schema would reject on read would vanish on the next launch.
      const parsed = schema.safeParse(next)
      if (parsed.success) {
        setRawValue(JSON.stringify(parsed.data))
      }
    },
    [schema, setRawValue],
  )

  return [value, setValue]
}
