import { describe, expect, it } from 'vitest'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from './frontmatter'

describe('splitFrontmatter', () => {
  it('returns the whole file as body when there is no frontmatter', () => {
    const split = splitFrontmatter('# Hello\n\nworld')
    expect(split).toEqual({ raw: null, body: '# Hello\n\nworld', bodyOffset: 0 })
  })

  it('carves a leading block and reports the body offset', () => {
    const source = '---\nid: x\n---\nbody'
    const split = splitFrontmatter(source)
    expect(split.raw).toBe('id: x')
    expect(split.body).toBe('body')
    expect(source.slice(split.bodyOffset)).toBe('body')
  })

  it('handles an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nbody').body).toBe('body')
  })

  it('treats an unterminated fence as plain body (tolerant)', () => {
    const source = '---\nid: x\nno closing fence'
    expect(splitFrontmatter(source)).toEqual({ raw: null, body: source, bodyOffset: 0 })
  })

  it('handles CRLF line endings', () => {
    const split = splitFrontmatter('---\r\nid: x\r\n---\r\nbody')
    expect(split.raw).toBe('id: x')
    expect(split.body).toBe('body')
  })
})

describe('parseFrontmatter', () => {
  it('types the known subset and passes through unknown keys', () => {
    const { data } = parseFrontmatter('id: abc\ncustom: hello\naliases:\n  - a\n  - b')
    expect(data.id).toBe('abc')
    expect(data.aliases).toEqual(['a', 'b'])
    expect(data.private).toBe(false)
    expect((data as Record<string, unknown>).custom).toBe('hello')
  })

  it('degrades broken YAML to defaults + a warning, never throwing', () => {
    const { data, warning } = parseFrontmatter('foo: [unclosed')
    expect(warning).toMatch(/invalid YAML/i)
    expect(data).toEqual({ aliases: [], private: false })
  })

  it('treats non-mapping frontmatter as ignored + a warning', () => {
    const { warning } = parseFrontmatter('just a bare string')
    expect(warning).toMatch(/not a mapping/i)
  })

  it('coerces the private flag fail-safe (boolean true, "yes"; absent/false → false)', () => {
    expect(parseFrontmatter('private: true').data.private).toBe(true)
    expect(parseFrontmatter('private: yes').data.private).toBe(true)
    expect(parseFrontmatter('private: false').data.private).toBe(false)
    expect(parseFrontmatter('private: no').data.private).toBe(false)
    expect(parseFrontmatter('id: x').data.private).toBe(false)
  })
})

describe('upsertFrontmatter', () => {
  it('creates a block when none exists', () => {
    expect(upsertFrontmatter('# Body', { id: 'x' })).toBe('---\nid: x\n---\n# Body')
  })

  it('updates a key while preserving unknown keys and the body byte-for-byte', () => {
    const source = '---\nid: x\ncustom: keep\n---\n# Body\n\ntext'
    const result = upsertFrontmatter(source, { private: true })
    expect(result).toContain('custom: keep')
    expect(result).toContain('private: true')
    expect(result.endsWith('# Body\n\ntext')).toBe(true)
  })

  it('deletes a key when the patch value is undefined', () => {
    const source = '---\nid: x\ncustom: keep\n---\nbody'
    const result = upsertFrontmatter(source, { id: undefined })
    expect(result).not.toContain('id: x')
    expect(result).toContain('custom: keep')
  })
})
