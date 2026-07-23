import { describe, expect, it } from 'vitest'
import { resolved, unresolved } from '../markdown'
import { nextAliases, rewriteLinksForTitleChange, type RenameIo } from './rename'

function fakeIo(
  files: Record<string, string>,
  options?: {
    resolveTo?: string
    resolveByTarget?: Record<string, string>
    backlinks?: Array<{ sourcePath: string; targetRaw: string; alias: string | null }>
  },
) {
  const writes: Record<string, string> = {}
  const io = {
    sources: async () => Object.keys(files).sort(),
    backlinks: async () => options?.backlinks ?? [],
    read: async (path) => {
      const content = files[path]
      if (content === undefined) {
        throw new Error(`unreadable: ${path}`)
      }
      return content
    },
    write: async (path, content) => {
      writes[path] = content
    },
    resolve: async (target) => {
      const mapped = options?.resolveByTarget?.[target]
      if (mapped !== undefined) {
        return resolved(mapped)
      }
      return options?.resolveTo !== undefined ? resolved(options.resolveTo) : unresolved('x')
    },
  } satisfies RenameIo & {
    backlinks: () => Promise<Array<{ sourcePath: string; targetRaw: string; alias: string | null }>>
  }
  return { io, writes }
}

describe('rewriteLinksForTitleChange', () => {
  it('rewrites [[from]] links across sources, preserving aliases', async () => {
    const { io, writes } = fakeIo({
      'notes/a.md': 'See [[Old Title]] for context.\n',
      'notes/b.md': 'Alias form: [[old title|the doc]].\n',
    })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result).toEqual({
      rewritten: ['notes/a.md', 'notes/b.md'],
      failed: [],
      collision: false,
      destinationBlocked: false,
    })
    expect(writes['notes/a.md']).toBe('See [[New Title]] for context.\n')
    expect(writes['notes/b.md']).toBe('Alias form: [[New Title|the doc]].\n')
  })

  it('skips the renamed note itself and sources without a rewritable link', async () => {
    const { io, writes } = fakeIo({
      'notes/target.md': '# New Title\n[[Old Title]] self-reference\n',
      'notes/c.md': 'mentions Old Title in prose only\n',
    })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.rewritten).toEqual([])
    expect(writes).toEqual({})
  })

  it('never rewrites link-shaped text inside code contexts', async () => {
    const { io, writes } = fakeIo({
      'notes/code.md':
        'Real: [[Old]]\n\n```\n[[Old]] in a fence\n```\n\nAnd `[[Old]] inline`.\n',
    })
    await rewriteLinksForTitleChange({ path: 'notes/t.md', from: 'Old', to: 'New', io })
    expect(writes['notes/code.md']).toBe(
      'Real: [[New]]\n\n```\n[[Old]] in a fence\n```\n\nAnd `[[Old]] inline`.\n',
    )
  })

  it('leaves links alone when the old title belongs to a different note now', async () => {
    const { io, writes } = fakeIo(
      { 'notes/a.md': '[[Old Title]]\n' },
      { resolveTo: 'notes/other-owner.md' },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.collision).toBe(true)
    expect(writes).toEqual({})
  })

  it('a stale index resolving to the renamed note itself is not a collision', async () => {
    const { io, writes } = fakeIo(
      { 'notes/a.md': '[[Old Title]]\n' },
      { resolveTo: 'notes/target.md' },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.collision).toBe(false)
    expect(writes['notes/a.md']).toBe('[[New Title]]\n')
  })

  it('continues past a failing source and reports it', async () => {
    const files: Record<string, string> = { 'notes/ok.md': '[[Old]] here\n' }
    const { io, writes } = fakeIo(files)
    const sources = ['notes/gone.md', 'notes/ok.md'] // gone.md read throws
    io.sources = async () => sources
    const progress: Array<[number, number]> = []
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old',
      to: 'New',
      io,
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(result.failed).toEqual(['notes/gone.md'])
    expect(result.rewritten).toEqual(['notes/ok.md'])
    expect(writes['notes/ok.md']).toBe('[[New]] here\n')
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})

describe('rewriteLinksForTitleChange stable-target displays', () => {
  it('updates a title-mirroring display while keeping the stable target', async () => {
    const sourcePath = 'daily/2026-07-23.md'
    const stableTarget = 'capture-2026-07-23-154848-811-c2b0'
    const { io, writes } = fakeIo(
      {
        [sourcePath]:
          `- [[${stableTarget}|Old Title]]\n` + `- [[${stableTarget}|Custom label]]\n`,
      },
      {
        resolveByTarget: { [stableTarget]: 'notes/capture.md' },
        backlinks: [
          { sourcePath, targetRaw: stableTarget, alias: 'Old Title' },
          { sourcePath, targetRaw: stableTarget, alias: 'Custom label' },
        ],
      },
    )

    const result = await rewriteLinksForTitleChange({
      path: 'notes/capture.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })

    expect(result.rewritten).toEqual([sourcePath])
    expect(writes[sourcePath]).toBe(
      `- [[${stableTarget}|New Title]]\n` + `- [[${stableTarget}|Custom label]]\n`,
    )
  })

  it('handles audio memo and user-defined stable aliases without note-type branches', async () => {
    const files = {
      'daily/2026-07-23.md': '[[audio-memo-2026-07-23-154848|Old Title]]\n',
      'notes/source.md': '[[stable-address|Old Title]]\n',
    }
    const { io, writes } = fakeIo(files, {
      resolveByTarget: {
        'audio-memo-2026-07-23-154848': 'notes/subject.md',
        'stable-address': 'notes/subject.md',
      },
      backlinks: [
        {
          sourcePath: 'daily/2026-07-23.md',
          targetRaw: 'audio-memo-2026-07-23-154848',
          alias: 'Old Title',
        },
        {
          sourcePath: 'notes/source.md',
          targetRaw: 'stable-address',
          alias: 'Old Title',
        },
      ],
    })

    await rewriteLinksForTitleChange({
      path: 'notes/subject.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })

    expect(writes).toEqual({
      'daily/2026-07-23.md': '[[audio-memo-2026-07-23-154848|New Title]]\n',
      'notes/source.md': '[[stable-address|New Title]]\n',
    })
  })

  it('rewrites title targets and stable displays in one source write', async () => {
    const sourcePath = 'notes/source.md'
    const { io, writes } = fakeIo(
      {
        [sourcePath]: '[[Old Title]] and [[stable-address|Old Title]]\n',
      },
      {
        resolveByTarget: { 'stable-address': 'notes/subject.md' },
        backlinks: [{ sourcePath, targetRaw: 'stable-address', alias: 'Old Title' }],
      },
    )
    const write = io.write
    let writeCount = 0
    io.write = async (path, content) => {
      writeCount += 1
      await write(path, content)
    }

    await rewriteLinksForTitleChange({
      path: 'notes/subject.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })

    expect(writeCount).toBe(1)
    expect(writes[sourcePath]).toBe('[[New Title]] and [[stable-address|New Title]]\n')
  })

  it('uses the rendered rich title for display comparison', async () => {
    const sourcePath = 'notes/source.md'
    const { io, writes } = fakeIo(
      {
        [sourcePath]: '[[stable-address|Meeting with Ada]]\n',
      },
      {
        resolveByTarget: { 'stable-address': 'notes/meeting.md' },
        backlinks: [
          { sourcePath, targetRaw: 'stable-address', alias: 'Meeting with Ada' },
        ],
      },
    )

    await rewriteLinksForTitleChange({
      path: 'notes/meeting.md',
      from: 'Meeting with [[Ada Lovelace|Ada]]',
      to: 'Meeting with [[Grace Hopper|Grace]]',
      io,
    })

    expect(writes[sourcePath]).toBe('[[stable-address|Meeting with Grace]]\n')
  })
})

describe('rewriteLinksForTitleChange write failures', () => {
  it('continues past a write failure and reports it', async () => {
    const { io, writes } = fakeIo({
      'notes/fail.md': '[[Old]]\n',
      'notes/ok.md': '[[Old]]\n',
    })
    const write = io.write
    io.write = async (path, content) => {
      if (path === 'notes/fail.md') {
        throw new Error('write failed')
      }
      await write(path, content)
    }
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old',
      to: 'New',
      io,
    })
    expect(result.failed).toEqual(['notes/fail.md'])
    expect(result.rewritten).toEqual(['notes/ok.md'])
    expect(writes['notes/ok.md']).toBe('[[New]]\n')
    expect(writes['notes/fail.md']).toBeUndefined()
  })
})

describe('nextAliases', () => {
  it('adds the old title and prunes the previous auto-alias', () => {
    expect(
      nextAliases(['First', 'keeper'], {
        from: 'Second',
        to: 'Third',
        previousAutoAlias: 'First',
      }),
    ).toEqual(['keeper', 'Second'])
  })

  it('does not duplicate an existing alias (case-insensitive)', () => {
    expect(
      nextAliases(['old title'], { from: 'Old Title', to: 'New', previousAutoAlias: null }),
    ).toBeNull()
  })

  it('returns null when nothing changes', () => {
    expect(
      nextAliases([], { from: 'Same', to: 'same', previousAutoAlias: null }),
    ).toBeNull()
  })

  it('adds the first alias to an empty list', () => {
    expect(nextAliases([], { from: 'Old', to: 'New', previousAutoAlias: null })).toEqual(['Old'])
  })
})

describe('rewriteLinksForTitleChange — rich titles', () => {
  it('rewrites links in the derived linkable space, not the raw title', async () => {
    const { io, writes } = fakeIo({
      'notes/source.md': 'See [[Meeting with Ada]] tomorrow.',
    })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/meeting.md',
      from: 'Meeting with [[Ada Lovelace|Ada]]',
      to: 'Meeting with [[Grace Hopper|Grace]]',
      io,
    })
    expect(result).toEqual({
      rewritten: ['notes/source.md'],
      failed: [],
      collision: false,
      destinationBlocked: false,
    })
    expect(writes['notes/source.md']).toBe('See [[Meeting with Grace]] tomorrow.')
  })

  it('keeps a trivial title byte-for-byte (double spaces survive)', async () => {
    const { io, writes } = fakeIo({
      'notes/source.md': 'See [[Old  Title]].',
    })
    await rewriteLinksForTitleChange({
      path: 'notes/old.md',
      from: 'Old  Title',
      to: 'New Title',
      io,
    })
    expect(writes['notes/source.md']).toBe('See [[New Title]].')
  })

  it('nextAliases preserves the raw rich title, not its derived form', () => {
    expect(
      nextAliases([], {
        from: 'Meeting with [[Ada Lovelace|Ada]]',
        to: 'Weekly Sync',
        previousAutoAlias: null,
      }),
    ).toEqual(['Meeting with [[Ada Lovelace|Ada]]'])
  })
})

describe('rewriteLinksForTitleChange — destination guard', () => {
  it('does not rewrite when the new derived target already belongs to another note', async () => {
    const { io, writes } = fakeIo(
      { 'notes/source.md': 'See [[Old Meeting]].\n' },
      { resolveByTarget: { 'Meeting with Ada': 'notes/plain.md' } },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/a.md',
      from: 'Old Meeting',
      to: 'Meeting with [[Ada Lovelace|Ada]]',
      io,
    })
    expect(result).toEqual({
      rewritten: [],
      failed: [],
      collision: false,
      destinationBlocked: true,
    })
    expect(writes).toEqual({})
  })

  it('does not rewrite into an unserializable derived target', async () => {
    const { io, writes } = fakeIo({ 'notes/source.md': 'See [[Old Meeting]].\n' })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/a.md',
      from: 'Old Meeting',
      to: 'C:\\notes [[Ada Lovelace|Ada]]',
      io,
    })
    expect(result).toEqual({
      rewritten: [],
      failed: [],
      collision: false,
      destinationBlocked: true,
    })
    expect(writes).toEqual({})
  })

  it('a destination already resolving to the renamed note itself is not blocked', async () => {
    const { io, writes } = fakeIo(
      { 'notes/source.md': 'See [[Old Meeting]].\n' },
      { resolveByTarget: { 'Meeting with Ada': 'notes/a.md' } },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/a.md',
      from: 'Old Meeting',
      to: 'Meeting with [[Ada Lovelace|Ada]]',
      io,
    })
    expect(result.destinationBlocked).toBe(false)
    expect(writes['notes/source.md']).toBe('See [[Meeting with Ada]].\n')
  })

  it('a source collision wins over a destination block (no alias may be claimed)', async () => {
    const { io, writes } = fakeIo(
      { 'notes/source.md': 'See [[Old Meeting]].\n' },
      {
        resolveByTarget: {
          'Old Meeting': 'notes/other-owner.md',
          'Meeting with Ada': 'notes/plain.md',
        },
      },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/a.md',
      from: 'Old Meeting',
      to: 'Meeting with [[Ada Lovelace|Ada]]',
      io,
    })
    expect(result).toEqual({
      rewritten: [],
      failed: [],
      collision: true,
      destinationBlocked: false,
    })
    expect(writes).toEqual({})
  })
})
