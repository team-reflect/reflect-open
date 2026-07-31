import { describe, expect, it } from 'vitest'
import { classifyAssetFromNotes } from './asset-privacy'

describe('classifyAssetFromNotes — vault-wide references', () => {
  it('blocks an asset a private note embeds by bare filename', async () => {
    // The index stored `photo.png`; the file is `Media/photo.png`.
    await expect(
      classifyAssetFromNotes(
        'Media/photo.png',
        ['private.md'],
        async () => '---\nprivate: true\n---\n\n![[photo.png]]\n',
      ),
    ).resolves.toBe('skip-private')
  })

  it('authorizes an asset a public note embeds by bare filename', async () => {
    await expect(
      classifyAssetFromNotes('Media/photo.png', ['public.md'], async () => '![[photo.png]]\n'),
    ).resolves.toBe('send')
  })

  it('still blocks an asset a private note references by an old vault-root href', async () => {
    await expect(
      classifyAssetFromNotes(
        'assets/a.png',
        ['notes/private.md'],
        async () => '---\nprivate: true\n---\n\n![](assets/a.png)\n',
      ),
    ).resolves.toBe('skip-private')
  })
})
