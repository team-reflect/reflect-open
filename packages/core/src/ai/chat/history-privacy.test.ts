import { describe, expect, it } from 'vitest'
import { validateChatSource } from './history-privacy'

describe('validateChatSource', () => {
  it('rechecks a note’s live private flag and fails closed on unreadable notes', async () => {
    const files: Record<string, string> = {
      'notes/public.md': '# Public\n',
      'notes/private.md': '---\nprivate: true\n---\n# Private\n',
    }
    const deps = {
      readNote: async (path: string) => {
        const source = files[path]
        if (source === undefined) {
          throw new Error('missing')
        }
        return source
      },
      assetReferencingNotePaths: async () => [],
    }
    await expect(validateChatSource({ kind: 'note', path: 'notes/public.md' }, deps)).resolves.toBe(
      true,
    )
    await expect(
      validateChatSource({ kind: 'note', path: 'notes/private.md' }, deps),
    ).resolves.toBe(false)
    await expect(
      validateChatSource({ kind: 'note', path: 'notes/missing.md' }, deps),
    ).resolves.toBe(false)
  })

  it('allows an asset only while its sidecar exists and every referer is public', async () => {
    const files: Record<string, string> = {
      'assets/chart.png.reflect.md': 'A chart',
      'notes/deck.md': '# Deck\n\n![chart](assets/chart.png)\n',
      'notes/diary.md': '---\nprivate: true\n---\n# Diary\n\n![chart](assets/chart.png)\n',
    }
    let referers = ['notes/deck.md']
    const deps = {
      readNote: async (path: string) => {
        const source = files[path]
        if (source === undefined) {
          throw new Error('missing')
        }
        return source
      },
      assetReferencingNotePaths: async () => referers,
    }
    const source = { kind: 'asset' as const, path: 'assets/chart.png' }
    await expect(validateChatSource(source, deps)).resolves.toBe(true)
    referers = ['notes/deck.md', 'notes/diary.md']
    await expect(validateChatSource(source, deps)).resolves.toBe(false)
  })
})
