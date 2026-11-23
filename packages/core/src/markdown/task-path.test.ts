import { describe, expect, it } from 'vitest'
import { compareTaskPaths, encodeTaskPath, isSameTaskPath } from './task-path.ts'

describe('task paths', () => {
  it('encodes a path as a JSON array', () => {
    expect(encodeTaskPath([2, 1])).toBe('[2,1]')
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
