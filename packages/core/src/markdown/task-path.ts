import { z } from 'zod'

export const taskPathSchema = z
  .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .min(1)
  .readonly()

/** A task's note and its child indexes from the note body's AST root. */
export interface TaskAddress {
  notePath: string
  astPath: readonly number[]
}

/** Decode a stored task address into child indexes. */
export function decodeTaskPath(value: string): readonly number[] {
  return taskPathSchema.parse(JSON.parse(value))
}

/** Canonical storage representation of child indexes. */
export function encodeTaskPath(path: readonly number[]): string {
  return JSON.stringify(path)
}

/** Document order: compare numeric children, then ancestors before descendants. */
export function compareTaskPaths(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.length - right.length
}
