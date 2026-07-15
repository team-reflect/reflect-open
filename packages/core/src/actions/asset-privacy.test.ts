import { describe, expect, it, vi } from 'vitest'
import { prepareAttachmentCatalog, type AttachmentFileMeta } from '../graph/attachment-resolution'
import {
  classifyAssetBatchFromNotes,
  classifyLiveAssetBatch,
  type AssetPrivacyNote,
} from './asset-privacy'

const ASSET = 'assets/a.png'

function attachment(path: string, placeholder = false): AttachmentFileMeta {
  return {
    path,
    size: 1,
    modifiedMs: 1,
    ...(placeholder ? { placeholder: true } : {}),
  }
}

function classify(
  sourcePath: string,
  source: string,
  catalogPaths: readonly AttachmentFileMeta[],
  assetPath = ASSET,
) {
  const catalog = prepareAttachmentCatalog(catalogPaths)
  return classifyAssetBatchFromNotes(
    [assetPath],
    [{ path: sourcePath, source }],
    catalog.resolve,
  ).get(assetPath)
}

describe('classifyAssetBatchFromNotes', () => {
  it('authorizes exact, encoded, and vault-qualified managed references', () => {
    expect(classify('Projects/n.md', '![](../assets/a.png)', [attachment(ASSET)])).toBe('send')
    expect(classify('Projects/n.md', '![](../%61ssets/a%2Epng)', [attachment(ASSET)])).toBe(
      'send',
    )
    expect(classify('Projects/n.md', '![[assets%2Fa.png]]', [attachment(ASSET)])).toBe('send')
  })

  it('authorizes a bare wiki embed only while its filename is unique', () => {
    const source = '![[a.png]]'
    expect(classify('Projects/n.md', source, [attachment(ASSET)])).toBe('send')
    expect(
      classify('Projects/n.md', source, [attachment(ASSET), attachment('Media/a.png')]),
    ).toBe('skip-unreferenced')
  })

  it('does not let a public Markdown root/source collision authorize either candidate', () => {
    expect(
      classify(
        'Projects/n.md',
        '![](assets/a.png)',
        [attachment(ASSET), attachment('Projects/assets/a.png')],
      ),
    ).toBe('skip-unreferenced')
  })

  it('matches filesystem aliases conservatively for private references', () => {
    const privatePrefix = '---\nprivate: true\n---\n'
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![](../assets/a.png)`,
        [attachment('assets/A.png')],
        'assets/A.png',
      ),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![](../assets/cafe\u0301.png)`,
        [attachment('assets/café.png')],
        'assets/café.png',
      ),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![](../assets/STRASSE.png)`,
        [attachment('assets/straße.png')],
        'assets/straße.png',
      ),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![](../assets/ος.png)`,
        [attachment('assets/οσ.png')],
        'assets/οσ.png',
      ),
    ).toBe('skip-private')
  })

  it('honors private frontmatter with a BOM or CR-only line endings', () => {
    expect(
      classify(
        'Projects/n.md',
        '\uFEFF---\nprivate: true\n---\n![](../assets/a.png)',
        [attachment(ASSET)],
      ),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        '---\rprivate: true\r---\r![](../assets/a.png)',
        [attachment(ASSET)],
      ),
    ).toBe('skip-private')
  })

  it('keeps public authorization exact across filesystem aliases', () => {
    expect(
      classify('Projects/n.md', '![](../assets/a.png)', [attachment('assets/A.png')], 'assets/A.png'),
    ).toBe('skip-unreferenced')
    expect(
      classify(
        'Projects/n.md',
        '![](../assets/cafe\u0301.png)',
        [attachment('assets/café.png')],
        'assets/café.png',
      ),
    ).toBe('skip-unreferenced')

    const catalog = [attachment('assets/a.png'), attachment('assets/A.png')]
    expect(classify('Projects/n.md', '![](../assets/a.png)', catalog, 'assets/a.png')).toBe(
      'send',
    )
    expect(classify('Projects/n.md', '![](../assets/a.png)', catalog, 'assets/A.png')).toBe(
      'skip-unreferenced',
    )
  })

  it('blocks a newly authored private reference without consulting derived index rows', () => {
    const privatePrefix = '---\nprivate: true\n---\n'
    expect(
      classify('Projects/n.md', `${privatePrefix}![](../assets/a.png)`, [attachment(ASSET)]),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![](assets/a.png)`,
        [attachment(ASSET), attachment('Projects/assets/a.png')],
      ),
    ).toBe('skip-private')
    expect(
      classify(
        'Projects/n.md',
        `${privatePrefix}![[a.png]]`,
        [attachment(ASSET), attachment('Media/a.png')],
      ),
    ).toBe('skip-private')
  })

  it('revokes a bare public embed when the live catalog becomes ambiguous', () => {
    const notes: AssetPrivacyNote[] = [{ path: 'Projects/n.md', source: '![[a.png]]' }]
    const unique = prepareAttachmentCatalog([attachment(ASSET)])
    const ambiguous = prepareAttachmentCatalog([attachment(ASSET), attachment('Media/a.png')])

    expect(classifyAssetBatchFromNotes([ASSET], notes, unique.resolve).get(ASSET)).toBe('send')
    expect(classifyAssetBatchFromNotes([ASSET], notes, ambiguous.resolve).get(ASSET)).toBe(
      'skip-unreferenced',
    )
  })

  it('requires availability for public authorization and blocks a private placeholder', () => {
    expect(classify('Projects/n.md', '![](../assets/a.png)', [attachment(ASSET, true)])).toBe(
      'skip-unreferenced',
    )
    expect(
      classify(
        'Projects/n.md',
        '---\nprivate: true\n---\n![](../assets/a.png)',
        [attachment(ASSET, true)],
      ),
    ).toBe('skip-private')
  })

  it('resolves each authored reference once for a ten-asset batch', () => {
    const paths = Array.from({ length: 10 }, (_, index) => `assets/${index}.png`)
    const source = paths.map((path) => `![](../${path})`).join('\n')
    const catalog = prepareAttachmentCatalog(paths.map((path) => attachment(path)))
    const resolve = vi.fn(catalog.resolve)

    const verdicts = classifyAssetBatchFromNotes(
      paths,
      [{ path: 'Projects/n.md', source }],
      resolve,
    )

    expect([...verdicts.values()]).toEqual(Array.from({ length: 10 }, () => 'send'))
    expect(resolve).toHaveBeenCalledTimes(10)
  })

  it('fails the whole batch closed on a parser or resolver failure', () => {
    const malformed = classifyAssetBatchFromNotes(
      [ASSET, 'assets/b.png'],
      [{ path: 'Projects/n.md', source: '---\nprivate: [\n---\n![](../assets/a.png)' }],
      prepareAttachmentCatalog([attachment(ASSET), attachment('assets/b.png')]).resolve,
    )
    const verdicts = classifyAssetBatchFromNotes(
      [ASSET, 'assets/b.png'],
      [{ path: 'Projects/n.md', source: '![](../assets/a.png)' }],
      () => {
        throw new Error('catalog failure')
      },
    )
    expect([...malformed.values()]).toEqual(['skip-private', 'skip-private'])
    expect([...verdicts.values()]).toEqual(['skip-private', 'skip-private'])
  })

  it('fails closed on unterminated leading frontmatter', () => {
    const verdicts = classifyAssetBatchFromNotes(
      [ASSET, 'assets/b.png'],
      [{ path: 'Projects/n.md', source: '---\nprivate: false\n![](../assets/a.png)' }],
      prepareAttachmentCatalog([attachment(ASSET), attachment('assets/b.png')]).resolve,
    )
    expect([...verdicts.values()]).toEqual(['skip-private', 'skip-private'])
  })

  it('never authorizes an unsupported managed path', () => {
    const verdicts = classifyAssetBatchFromNotes(
      ['assets/a.mp3'],
      [{ path: 'Projects/n.md', source: '![](../assets/a.mp3)' }],
      prepareAttachmentCatalog([attachment('assets/a.mp3')]).resolve,
    )
    expect(verdicts.size).toBe(0)
  })
})

describe('classifyLiveAssetBatch', () => {
  it('lists once and reads every live note once for the complete batch', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `assets/${index}.png`)
    const noteSources = new Map([
      ['Projects/a.md', paths.slice(0, 5).map((path) => `![](../${path})`).join('\n')],
      ['Projects/b.md', paths.slice(5).map((path) => `![](../${path})`).join('\n')],
    ])
    const listedNotes = [...noteSources.keys()].map((path) => ({
      path,
      size: 1,
      modifiedMs: 1,
    }))
    const listFiles = vi.fn(async () => [...listedNotes, listedNotes[0]!])
    const listAttachments = vi.fn(async () => paths.map((path) => attachment(path)))
    const readNote = vi.fn(async (path: string) => noteSources.get(path)!)

    const verdicts = await classifyLiveAssetBatch(paths, { listFiles, listAttachments, readNote })

    expect([...verdicts.values()]).toEqual(Array.from({ length: 10 }, () => 'send'))
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listAttachments).toHaveBeenCalledTimes(1)
    expect(readNote).toHaveBeenCalledTimes(2)
  })

  it('blocks the whole batch for a placeholder without reading any note', async () => {
    const readNote = vi.fn(async () => '# unreachable')
    const verdicts = await classifyLiveAssetBatch([ASSET, 'assets/b.png'], {
      listFiles: async () => [
        { path: 'Projects/remote.md', size: 1, modifiedMs: 1, placeholder: true },
      ],
      listAttachments: async () => [attachment(ASSET), attachment('assets/b.png')],
      readNote,
    })

    expect([...verdicts.values()]).toEqual(['skip-private', 'skip-private'])
    expect(readNote).not.toHaveBeenCalled()
  })

  it('blocks the whole batch when a listed note is missing or unreadable', async () => {
    for (const failure of [
      { kind: 'notFound', message: 'gone' },
      { kind: 'io', message: 'unavailable' },
    ]) {
      const verdicts = await classifyLiveAssetBatch([ASSET, 'assets/b.png'], {
        listFiles: async () => [{ path: 'Projects/n.md', size: 1, modifiedMs: 1 }],
        listAttachments: async () => [attachment(ASSET), attachment('assets/b.png')],
        readNote: async () => {
          throw failure
        },
      })
      expect([...verdicts.values()]).toEqual(['skip-private', 'skip-private'])
    }
  })

  it('blocks the whole batch when either live listing fails', async () => {
    for (const failedEffect of ['notes', 'attachments'] as const) {
      const verdicts = await classifyLiveAssetBatch([ASSET, 'assets/b.png'], {
        listFiles: async () => {
          if (failedEffect === 'notes') throw new Error('note listing failed')
          return []
        },
        listAttachments: async () => {
          if (failedEffect === 'attachments') throw new Error('catalog failed')
          return []
        },
        readNote: async () => '# unreachable',
      })
      expect([...verdicts.values()]).toEqual(['skip-private', 'skip-private'])
    }
  })
})
