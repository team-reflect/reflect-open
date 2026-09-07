import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './markdown-preview'

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

describe('MarkdownPreview wiki-link chips', () => {
  it('labels chips through the host resolver and reports the full target', async () => {
    const onWikiLinkClick = vi.fn()
    const view = await render(
      <MarkdownPreview
        content={'see [[Tim MacCaw // Dad|Dad]] and [[Tim MacCaw // Dad]]'}
        onWikiLinkClick={onWikiLinkClick}
      />,
    )
    const chips = view.getByTestId('wikilink')
    await expect.element(chips.first()).toHaveTextContent(/^Dad$/)
    await expect.element(chips.last()).toHaveTextContent(/^Tim MacCaw$/)
    await chips.first().click()
    expect(onWikiLinkClick).toHaveBeenCalledWith({
      target: 'Tim MacCaw // Dad',
      openInNewWindow: false,
    })
    await view.unmount()
  })
})
