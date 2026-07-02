import { describe, expect, it } from 'vitest'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from './frontmatter'
import { isPinned, pinnedOrder } from './model'

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
    expect((data as Record<string, unknown>)['custom']).toBe('hello')
  })

  it('degrades broken YAML to defaults + a warning, never throwing', () => {
    const { data, warning } = parseFrontmatter('foo: [unclosed')
    expect(warning).toMatch(/invalid YAML/i)
    expect(data).toEqual({ aliases: [], private: false, pinned: false, ignoredContacts: [] })
  })

  it('treats non-mapping frontmatter as ignored + a warning', () => {
    const { warning } = parseFrontmatter('just a bare string')
    expect(warning).toMatch(/not a mapping/i)
  })

  it('coerces the private flag explicitly (true/yes; false/no/unknown/absent → false)', () => {
    expect(parseFrontmatter('private: true').data.private).toBe(true)
    expect(parseFrontmatter('private: yes').data.private).toBe(true)
    expect(parseFrontmatter('private: false').data.private).toBe(false)
    expect(parseFrontmatter('private: no').data.private).toBe(false)
    expect(parseFrontmatter('private: banana').data.private).toBe(false)
    expect(parseFrontmatter('id: x').data.private).toBe(false)
  })

  it('coerces the pinned value: booleans, truthy words, numbers as explicit order', () => {
    expect(parseFrontmatter('pinned: true').data.pinned).toBe(true)
    expect(parseFrontmatter('pinned: yes').data.pinned).toBe(true)
    expect(parseFrontmatter('pinned: false').data.pinned).toBe(false)
    expect(parseFrontmatter('pinned: banana').data.pinned).toBe(false)
    expect(parseFrontmatter('id: x').data.pinned).toBe(false)
    expect(parseFrontmatter('pinned: 2').data.pinned).toBe(2)
    expect(parseFrontmatter('pinned: 1.5').data.pinned).toBe(1.5)
    expect(parseFrontmatter('pinned: .nan').data.pinned).toBe(false)
  })

  it('reads the ignored-contacts list; junk degrades to empty', () => {
    expect(
      parseFrontmatter('ignoredContacts:\n  - Ada Lovelace\n  - Grace Hopper').data
        .ignoredContacts,
    ).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(parseFrontmatter('ignoredContacts: banana').data.ignoredContacts).toEqual([])
    expect(parseFrontmatter('ignoredContacts:\n  - 42').data.ignoredContacts).toEqual([])
    expect(parseFrontmatter('id: x').data.ignoredContacts).toEqual([])
  })

  it('isPinned/pinnedOrder read the pin value — `pinned: 0` is order 0, pinned', () => {
    expect(isPinned(parseFrontmatter('pinned: 0').data)).toBe(true)
    expect(pinnedOrder(parseFrontmatter('pinned: 0').data)).toBe(0)
    expect(isPinned(parseFrontmatter('pinned: true').data)).toBe(true)
    expect(pinnedOrder(parseFrontmatter('pinned: true').data)).toBeNull()
    expect(isPinned(parseFrontmatter('id: x').data)).toBe(false)
    expect(pinnedOrder(parseFrontmatter('id: x').data)).toBeNull()
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

  it('is a byte-identical no-op for an empty patch (never re-serializes)', () => {
    const source = '---\nid: x # keep this comment\ncustom: keep\n---\n# Body'
    expect(upsertFrontmatter(source, {})).toBe(source)
  })

  it('refuses to update invalid frontmatter rather than dropping bytes', () => {
    expect(() => upsertFrontmatter('---\nfoo: [unclosed\n---\nbody', { id: 'x' })).toThrow(
      /invalid YAML frontmatter/i,
    )
  })

  it('deletes a key when the patch value is undefined', () => {
    const source = '---\nid: x\ncustom: keep\n---\nbody'
    const result = upsertFrontmatter(source, { id: undefined })
    expect(result).not.toContain('id: x')
    expect(result).toContain('custom: keep')
  })

  it('removes the whole block when the last key is deleted', () => {
    expect(upsertFrontmatter('---\npinned: true\n---\n# Body', { pinned: undefined })).toBe(
      '# Body',
    )
  })

  it('does not create a block for a deletion-only patch', () => {
    expect(upsertFrontmatter('# Body', { pinned: undefined })).toBe('# Body')
  })

  it('round-trips pin → unpin back to the original source', () => {
    const source = '# Body\n\ntext'
    const pinned = upsertFrontmatter(source, { pinned: true })
    expect(pinned).toBe('---\npinned: true\n---\n# Body\n\ntext')
    expect(upsertFrontmatter(pinned, { pinned: undefined })).toBe(source)
  })

  it('writes a nested mapping (the gist block) and round-trips it through the parser', () => {
    const gist = { id: 'g1', url: 'https://gist.github.com/alex/g1', file: 'A.md', hash: 'ab12cd34ef56ab78' }
    const next = upsertFrontmatter('# A\n\nbody', { gist })
    const split = splitFrontmatter(next)
    expect(split.body).toBe('# A\n\nbody')
    expect(parseFrontmatter(split.raw).data.gist).toEqual(gist)
  })

  it('replaces an existing gist block wholesale on republish', () => {
    const first = upsertFrontmatter('body', {
      gist: { id: 'g1', url: 'https://gist.github.com/alex/g1', file: 'Old.md', hash: 'h1' },
    })
    const second = upsertFrontmatter(first, {
      gist: { id: 'g1', url: 'https://gist.github.com/alex/g1', file: 'New.md', hash: 'h2' },
    })
    const { data } = parseFrontmatter(splitFrontmatter(second).raw)
    expect(data.gist).toEqual({
      id: 'g1',
      url: 'https://gist.github.com/alex/g1',
      file: 'New.md',
      hash: 'h2',
    })
    expect(second).not.toContain('Old.md')
  })
})

describe('frontmatter gist block', () => {
  it('parses a well-formed block', () => {
    const { data } = parseFrontmatter(
      'gist:\n  id: g1\n  url: https://gist.github.com/alex/g1\n  file: A.md\n  hash: ab12cd34ef56ab78',
    )
    expect(data.gist).toEqual({
      id: 'g1',
      url: 'https://gist.github.com/alex/g1',
      file: 'A.md',
      hash: 'ab12cd34ef56ab78',
    })
  })

  it('coerces all-digit ids and hashes a third-party rewrite may have unquoted', () => {
    const { data } = parseFrontmatter(
      'gist:\n  id: 12345678\n  url: https://gist.github.com/alex/g1\n  file: A.md\n  hash: 1234567812345678',
    )
    expect(data.gist?.id).toBe('12345678')
    expect(data.gist?.hash).toBe('1234567812345678')
  })

  it('rejects a non-http(s) gist url, degrading to "never published"', () => {
    expect(
      parseFrontmatter(
        'gist:\n  id: g1\n  url: file:///etc/passwd\n  file: A.md\n  hash: h1',
      ).data.gist,
    ).toBeUndefined()
    expect(
      parseFrontmatter(
        'gist:\n  id: g1\n  url: javascript:alert(1)\n  file: A.md\n  hash: h1',
      ).data.gist,
    ).toBeUndefined()
  })

  it('degrades a mangled block to "never published" without failing the note', () => {
    expect(parseFrontmatter('gist: not-an-object').data.gist).toBeUndefined()
    expect(parseFrontmatter('gist:\n  id: g1').data.gist).toBeUndefined()
  })
})
