/**
 * A value, or a promise of that value.
 */
export type MaybePromise<T> = T | Promise<T>

/**
 * `T` with every property writable.
 */
export type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }
