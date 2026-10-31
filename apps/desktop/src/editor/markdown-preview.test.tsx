import { describe, expect, it, vi } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MarkdownPreview } from './markdown-preview.tsx'

describe('MarkdownPreview wiki-link chips', () => {
  it('labels chips through the host resolver and reports the full target', async () => {
    const onWikiLinkClick = vi.fn()
    const view = await renderInApp(
      <MarkdownPreview
        content={'see [[Tim MacCaw // Dad|Dad]] and [[Tim MacCaw // Dad]]'}
        sourcePath={null}
        onWikiLinkClick={onWikiLinkClick}
      />,
      { graph: { root: '/g', name: 'g', generation: 7 } },
    )
    const chips = view.getByTestId('wikilink')
    await expect.element(chips.first()).toMatchTextContent(/^Dad$/)
    await expect.element(chips.last()).toMatchTextContent(/^Tim MacCaw$/)
    await chips.first().click()
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: 'Tim MacCaw // Dad',
      openInNewWindow: false,
    })
  })
})
