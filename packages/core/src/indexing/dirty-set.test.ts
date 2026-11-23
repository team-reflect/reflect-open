import { describe, expect, it } from 'vitest'
import { createDirtySet } from './dirty-set.ts'

describe('createDirtySet', () => {
  it('keeps one entry per path, in the order the paths were first added', () => {
    const dirty = createDirtySet()

    dirty.add('notes/a.md', { modifiedMs: 1 })
    dirty.add('notes/b.md')
    dirty.add('notes/a.md', { modifiedMs: 2 })

    expect(dirty.size()).toBe(2)
    expect(dirty.take().map((entry) => [entry.path, entry.modifiedMs])).toEqual([
      ['notes/a.md', 2],
      ['notes/b.md', undefined],
    ])
  })

  it('takes every entry once', () => {
    const dirty = createDirtySet()
    dirty.add('notes/a.md')

    expect(dirty.take()).toHaveLength(1)
    expect(dirty.take()).toEqual([])
  })

  it('drops older content when a later add carries none', () => {
    const dirty = createDirtySet()

    dirty.add('notes/a.md', { note: { content: '# old', hash: 'h' }, modifiedMs: 1 })
    dirty.add('notes/a.md')

    expect(dirty.take()).toEqual([
      {
        path: 'notes/a.md',
        kind: 'upsert',
        modifiedMs: undefined,
        note: undefined,
        force: false,
        bulk: false,
      },
    ])
  })

  it('lets the latest kind win', () => {
    const dirty = createDirtySet()

    dirty.add('notes/gone.md', { note: { content: '# text', hash: 'h' } })
    dirty.add('notes/gone.md', { kind: 'remove' })
    dirty.add('notes/back.md', { kind: 'remove' })
    dirty.add('notes/back.md', { modifiedMs: 7 })

    expect(dirty.take().map((entry) => [entry.path, entry.kind, entry.note?.content])).toEqual([
      ['notes/gone.md', 'remove', undefined],
      ['notes/back.md', 'upsert', undefined],
    ])
  })

  it('keeps `force` through a later add without it', () => {
    const dirty = createDirtySet()

    dirty.add('notes/a.md', { force: true })
    dirty.add('notes/a.md', { modifiedMs: 3 })

    expect(dirty.take().map((entry) => entry.force)).toEqual([true])
  })

  it('keeps an entry `bulk` only while every add for it is', () => {
    const dirty = createDirtySet()

    dirty.add('notes/pass.md', { bulk: true })
    dirty.add('notes/pass.md', { bulk: true })
    dirty.add('notes/watched.md', { bulk: true })
    dirty.add('notes/watched.md')
    dirty.add('notes/watched.md', { bulk: true })

    expect(dirty.take().map((entry) => [entry.path, entry.bulk])).toEqual([
      ['notes/pass.md', true],
      ['notes/watched.md', false],
    ])
  })

  it('restores a taken entry, and keeps the hint of a newer add', () => {
    const dirty = createDirtySet()
    dirty.add('notes/kept.md', { note: { content: '# taken', hash: 'h' } })
    dirty.add('notes/changed.md', { note: { content: '# taken', hash: 'h' }, force: true })
    const taken = dirty.take()
    dirty.add('notes/changed.md', { modifiedMs: 9 })

    dirty.restore(taken)

    expect(
      dirty
        .take()
        .map((entry) => [entry.path, entry.note?.content, entry.modifiedMs, entry.force])
        .toSorted(),
    ).toEqual([
      ['notes/changed.md', undefined, 9, true],
      ['notes/kept.md', '# taken', undefined, false],
    ])
  })
})
