import { describe, expect, it } from 'vitest'
import { compareTaskPaths, decodeTaskPath, encodeTaskPath, isSameTaskPath } from './task-path.ts'

describe('task paths', () => {
  it('round-trips a path through its stored form', () => {
    expect(encodeTaskPath([2, 1])).toBe('[2,1]')
    expect(decodeTaskPath('[2,1]')).toEqual([2, 1])
  })

  it('rejects stored values that are not a non-empty list of child indexes', () => {
    expect(() => decodeTaskPath('[]')).toThrow()
    expect(() => decodeTaskPath('[-1]')).toThrow()
    expect(() => decodeTaskPath('[1.5]')).toThrow()
    expect(() => decodeTaskPath('"[1]"')).toThrow()
  })

  it('compares paths by value', () => {
    expect(isSameTaskPath([0, 3], [0, 3])).toBe(true)
    expect(isSameTaskPath([0, 3], [0, 3, 0])).toBe(false)
    expect(isSameTaskPath([0, 3], [0, 4])).toBe(false)
  })

  it('sorts paths in document order', () => {
    const paths = [[2], [0, 10], [0, 2, 1], [0, 2], [10], [0]]
    expect([...paths].sort(compareTaskPaths)).toEqual([[0], [0, 2], [0, 2, 1], [0, 10], [2], [10]])
    expect(compareTaskPaths([1], [1])).toBe(0)
  })
})
