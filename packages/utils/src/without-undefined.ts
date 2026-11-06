/**
 * A shallow copy of `value` without the properties whose value is `undefined`,
 * typed for targets with `exactOptionalPropertyTypes`.
 */
export function withoutUndefined<T extends object>(value: {
  [K in keyof T]: T[K] | undefined
}): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
