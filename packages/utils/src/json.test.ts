import { describe, expect, it } from 'vitest'
import { safeParseJson } from './index.ts'

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson('{"a":[1,true]}')).toEqual({ a: [1, true] })
    expect(safeParseJson('null')).toBeNull()
  })

  it('is undefined for anything that is not valid JSON', () => {
    expect(safeParseJson('')).toBeUndefined()
    expect(safeParseJson('{')).toBeUndefined()
    expect(safeParseJson('undefined')).toBeUndefined()
  })
})
