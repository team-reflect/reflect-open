import { describe, expect, it } from 'vitest'
import { subjectAliases } from './subject-aliases'

describe('subjectAliases', () => {
  it('derives every segment of a v1 subject, first included', () => {
    expect(subjectAliases('Charlotte MacCaw // Mum')).toEqual(['Charlotte MacCaw', 'Mum'])
  })

  it('handles more than two segments', () => {
    expect(subjectAliases('Acme Inc // Acme // The A')).toEqual(['Acme Inc', 'Acme', 'The A'])
  })

  it('splits without surrounding spaces', () => {
    expect(subjectAliases('Charlotte//Mum')).toEqual(['Charlotte', 'Mum'])
  })

  it('derives nothing from a plain title', () => {
    expect(subjectAliases('Charlotte MacCaw')).toEqual([])
  })

  it('keeps the remaining segment of a trailing separator', () => {
    expect(subjectAliases('Charlotte MacCaw // ')).toEqual(['Charlotte MacCaw'])
  })

  it('drops empty and duplicate segments (case-insensitively)', () => {
    expect(subjectAliases('Mum //  // MUM // Mother')).toEqual(['Mum', 'Mother'])
  })

  it('never splits a URL scheme', () => {
    expect(subjectAliases('https://reflect.app')).toEqual([])
    expect(subjectAliases('Reflect // https://reflect.app')).toEqual([
      'Reflect',
      'https://reflect.app',
    ])
  })

  it('never splits slash runs', () => {
    expect(subjectAliases('a///b')).toEqual([])
    expect(subjectAliases('file:///etc/hosts')).toEqual([])
  })
})
