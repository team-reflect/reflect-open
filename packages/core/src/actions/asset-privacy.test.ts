import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getXArchiveOwners } from '../x-archive/commands'
import { classifyAssetFromNotes } from './asset-privacy'

vi.mock('../x-archive/commands', () => ({ getXArchiveOwners: vi.fn() }))

const asset = `assets/x/url_sha256_${'a'.repeat(64)}.png`

beforeEach(() => {
  vi.mocked(getXArchiveOwners).mockReset().mockResolvedValue(['assets/x/post-123.json'])
})

it('keeps private tweet references when the same media has a public direct reference', async () => {
  const sources = new Map([
    ['public.md', `![Image](${asset})`],
    ['private.md', '---\nprivate: true\n---\n![](https://x.com/jack/status/123)'],
  ])
  expect(
    await classifyAssetFromNotes(asset, [...sources.keys()], async (path) => sources.get(path)!),
  ).toBe('skip-private')
})

it('checks live ownership instead of treating every private candidate as a reference', async () => {
  const sources = new Map([
    ['public.md', `![Image](${asset})`],
    ['private.md', '---\nprivate: true\n---\n![](https://x.com/jack/status/456)'],
  ])
  expect(
    await classifyAssetFromNotes(asset, [...sources.keys()], async (path) => sources.get(path)!),
  ).toBe('send')
})

it('recognizes a public tweet reference without a direct media link', async () => {
  expect(
    await classifyAssetFromNotes(
      asset,
      ['public.md'],
      async () => '![](https://x.com/jack/status/123)',
    ),
  ).toBe('send')
})

it('does not return a send verdict when archive ownership cannot be read', async () => {
  vi.mocked(getXArchiveOwners).mockRejectedValue(new Error('unreadable archive'))
  await expect(
    classifyAssetFromNotes(asset, ['public.md'], async () => `![Image](${asset})`),
  ).rejects.toThrow('unreadable archive')
})

// FIXME: stray ' , ' left from an em-dash removal in an existing title that should have stayed
// byte-identical; restore it.
describe('classifyAssetFromNotes , vault-wide references', () => {
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
