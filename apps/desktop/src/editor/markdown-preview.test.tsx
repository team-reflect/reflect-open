import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import '@/test-utils/locator'
import { MarkdownPreview } from './markdown-preview'

vi.mock('@/editor/open-external-link', () => ({
  useOpenExternalLink: () => vi.fn(),
}))

const previewRoot = page.locate('.reflect-native-direction')
const markdownRoot = page.locate('.reflect-native-direction > .reflect-editor')

afterEach(() => {
  document.documentElement.removeAttribute('data-editor-text-direction')
})

describe('MarkdownPreview native text direction', () => {
  it('inherits one browser-resolved automatic direction across the preview', async () => {
    await render(<MarkdownPreview content={'עברית תחילה\n\nEnglish second'} />)

    await expect.element(previewRoot).toHaveAttribute('dir', 'auto')
    expect(getComputedStyle(markdownRoot.element()).direction).toBe('rtl')

    const blocks = Array.from(markdownRoot.element().children)
    expect(blocks).toHaveLength(2)
    expect(blocks.every((block) => !block.hasAttribute('dir'))).toBe(true)
    expect(blocks.every((block) => getComputedStyle(block).direction === 'rtl')).toBe(true)
  })

  it('follows an explicit note direction from the document setting', async () => {
    document.documentElement.setAttribute('data-editor-text-direction', 'rtl')
    await render(<MarkdownPreview content="English content" />)

    await expect.element(previewRoot).toHaveAttribute('dir', 'auto')
    expect(getComputedStyle(markdownRoot.element()).direction).toBe('rtl')
  })

  it('keeps a fixed-LTR UI preview LTR when the note setting is RTL', async () => {
    document.documentElement.setAttribute('data-editor-text-direction', 'rtl')
    await render(<MarkdownPreview content="משימה בעברית" textDirection="ltr" />)

    await expect.element(previewRoot).toHaveAttribute('dir', 'ltr')
    expect(getComputedStyle(markdownRoot.element()).direction).toBe('ltr')
  })
})
