import { describe, expect, it } from 'vitest'
import {
  nextAliases,
  prepareNoteMoveRewrites,
  rewriteLinksForTitleChange,
  type RenameIo,
} from './rename'

function fakeIo(
  files: Record<string, string>,
  options?: { resolveTo?: string; ambiguous?: readonly string[] },
) {
  const writes: Record<string, string> = {}
  const io: RenameIo = {
    sources: async () => Object.keys(files).sort(),
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
    resolve: async () => {
      if (options?.ambiguous !== undefined) {
        return { kind: 'ambiguous', paths: options.ambiguous }
      }
      return options?.resolveTo !== undefined
        ? { kind: 'resolved', path: options.resolveTo }
        : { kind: 'missing' }
    },
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
    expect(result).toEqual({ rewritten: ['notes/a.md', 'notes/b.md'], failed: [], collision: false })
    expect(writes['notes/a.md']).toBe('See [[New Title]] for context.\n')
    expect(writes['notes/b.md']).toBe('Alias form: [[New Title|the doc]].\n')
  })

  it('rewrites self-links in the renamed note and skips sources without a rewritable link', async () => {
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
    expect(result.rewritten).toEqual(['notes/target.md'])
    expect(writes).toEqual({
      'notes/target.md': '# New Title\n[[New Title]] self-reference\n',
    })
  })

  it('keeps a moved note\'s fragment-only Markdown links fragment-only', async () => {
    const source = '# Old\n\n[Jump](#Details)\n\n## Details\n'
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old.md',
      toPath: 'notes/new.md',
      notePaths: ['notes/old.md'],
      read: async () => source,
    })

    expect(result).toEqual({
      rewrites: [],
      failed: [],
    })
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

  it('leaves links alone when duplicate notes own the old title', async () => {
    const { io, writes } = fakeIo(
      { 'notes/a.md': '[[Old Title]]\n' },
      { ambiguous: ['notes/first.md', 'notes/second.md'] },
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

describe('prepareNoteMoveRewrites', () => {
  function prepareMove(
    files: Readonly<Record<string, string | null>>,
    fromPath = 'notes/old-title.md',
    toPath = 'notes/new-title.md',
  ) {
    return prepareNoteMoveRewrites({
      fromPath,
      toPath,
      notePaths: Object.keys(files),
      read: async (path) => {
        const source = files[path]
        if (source === undefined || source === null) {
          throw new Error(`unavailable: ${path}`)
        }
        return source
      },
    })
  }

  it('finds unindexed path links across the live manifest and preserves labels and fragments', async () => {
    const source = [
      'Wiki: [[notes/old-title#Details|the plan]].',
      'Markdown: [the plan](../notes/old-title.md#Details "keep title").',
      'Bare title stays [[Old Title]].',
      '',
    ].join('\n')
    const result = await prepareMove({
      'notes/old-title.md': '# Old Title\n',
      'Projects/source.md': source,
    })

    expect(result.failed).toEqual([])
    expect(result.rewrites).toEqual([
      {
        path: 'Projects/source.md',
        before: source,
        after: [
          'Wiki: [[notes/new-title#Details|the plan]].',
          'Markdown: [the plan](../notes/new-title.md#Details "keep title").',
          'Bare title stays [[Old Title]].',
          '',
        ].join('\n'),
      },
    ])
  })

  it('preserves optional extensions, root-relative hrefs, and bracketed href syntax', async () => {
    const source = '[[notes/old-title.md|Wiki]] [Root](</notes/old-title#Part>)\n'
    const result = await prepareMove({
      'notes/old-title.md': '# Old Title\n',
      'README.md': source,
    })

    expect(result.failed).toEqual([])
    expect(result.rewrites[0]!.after).toBe(
      '[[notes/new-title.md|Wiki]] [Root](</notes/new-title#Part>)\n',
    )
  })

  it('rewrites one shared reference definition destination without touching usages or title', async () => {
    const source = [
      '[First label][plan], [plan][], and [PLAN].',
      '',
      '[plan]: <../notes/old-title.md#Details> "Keep title"',
      '',
    ].join('\n')
    const result = await prepareMove({
      'notes/old-title.md': '# Old Title\n',
      'Projects/source.md': source,
    })

    expect(result.failed).toEqual([])
    expect(result.rewrites[0]?.after).toBe(
      [
        '[First label][plan], [plan][], and [PLAN].',
        '',
        '[plan]: <../notes/new-title.md#Details> "Keep title"',
        '',
      ].join('\n'),
    )
  })

  it('fails closed when a live source has duplicate reference definitions', async () => {
    const result = await prepareMove(
      {
        'notes/old.md': '# Old\n',
        'source.md':
          '[Plan][doc]\n\n[doc]: notes/old.md#Part "First"\n\n[DOC]: notes/other.md "Duplicate"\n',
      },
      'notes/old.md',
      'notes/new.md',
    )
    expect(result).toEqual({ rewrites: [], failed: ['source.md'] })
  })

  it('rewrites every current occurrence even when the index knew about only one', async () => {
    const source = [
      '[[notes/old]] and [[notes/old|again]].',
      '[One](../notes/old.md) and [Two](../notes/old.md).',
      '',
    ].join('\n')
    const result = await prepareMove(
      { 'notes/old.md': '# Old\n', 'Projects/source.md': source },
      'notes/old.md',
      'notes/new.md',
    )
    expect(result.failed).toEqual([])
    expect(result.rewrites[0]?.after).toBe(
      [
        '[[notes/new]] and [[notes/new|again]].',
        '[One](../notes/new.md) and [Two](../notes/new.md).',
        '',
      ].join('\n'),
    )
  })

  it('fails closed when any generation-pinned live note is unavailable', async () => {
    const result = await prepareMove(
      {
        'notes/old.md': '# Old\n',
        'Projects/source.md': '[[notes/old]]\n',
        'Projects/placeholder.md': null,
      },
      'notes/old.md',
      'notes/new.md',
    )
    expect(result.rewrites).toEqual([
      {
        path: 'Projects/source.md',
        before: '[[notes/old]]\n',
        after: '[[notes/new]]\n',
      },
    ])
    expect(result.failed).toEqual(['Projects/placeholder.md'])
  })

  it('ignores bare-title wikilinks and never rewrites wiki embeds', async () => {
    const source = '[[Old]] ![[notes/old]]\n'
    const result = await prepareMove(
      { 'notes/old.md': '# Old\n', 'notes/source.md': source },
      'notes/old.md',
      'notes/new.md',
    )
    expect(result).toEqual({ rewrites: [], failed: [] })
  })

  it('fails closed when an unqualified Markdown href is live-ambiguous', async () => {
    const source = '[Old](notes/old.md)\n'
    const result = await prepareMove(
      {
        'notes/old.md': '# Root Old\n',
        'Projects/notes/old.md': '# Relative Old\n',
        'Projects/source.md': source,
      },
      'notes/old.md',
      'notes/new.md',
    )

    expect(result).toEqual({ rewrites: [], failed: ['Projects/source.md'] })
  })

  it('fails closed when multiple live paths share the moved note path key', async () => {
    const source = '[Old](notes/old.md)\n'
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old.md',
      toPath: 'notes/new.md',
      notePaths: ['notes/old.md', 'Notes/OLD.md', 'source.md'],
      read: async (path) => (path === 'source.md' ? source : '# Old\n'),
    })

    expect(result.rewrites).toEqual([])
    expect(new Set(result.failed)).toEqual(new Set(['notes/old.md', 'Notes/OLD.md']))
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
