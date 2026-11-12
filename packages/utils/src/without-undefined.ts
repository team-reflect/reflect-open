type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

/**
 * A shallow copy of `value` without the own string-keyed properties whose value
 * is `undefined`. Only optional properties of `T` may be `undefined`, so the
 * result satisfies `T` under `exactOptionalPropertyTypes`.
 */
export function withoutUndefined<T extends object>(value: {
  [K in keyof T]: K extends OptionalKeys<T> ? T[K] | undefined : T[K]
}): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
