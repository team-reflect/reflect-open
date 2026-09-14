import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { CapturePopup } from './app'

const captured = vi.hoisted(() => ({
  status: 'ready',
  tabId: 1,
  page: { url: 'https://x.com/author/status/123', title: 'Post' },
}))
vi.mock('./use-captured-page', () => ({ useCapturedPage: () => captured }))
vi.mock('wxt/browser', () => ({ browser: {} }))
vi.mock('@/lib/flush', () => ({ readQueue: vi.fn() }))
vi.mock('@/lib/save-capture', () => ({ saveCapture: vi.fn() }))
vi.mock('@/lib/popup-preferences', () => ({
  readIncludePageTextPreference: vi.fn(),
  writeIncludePageTextPreference: vi.fn(),
}))
vi.mock('./extract-page-text', () => ({ tryExtractPageText: vi.fn() }))

it('hides ignored options for X posts and enables saving without page-text preferences', () => {
  captured.page.url = 'https://x.com/author/status/123'
  const html = renderToStaticMarkup(createElement(CapturePopup))
  expect(html).not.toContain('Add a note (optional)')
  expect(html).not.toContain('Capture page text')
  expect(html).not.toContain('disabled')
  expect(html).toContain('Save to Reflect')
})

it('keeps note and page-text options for ordinary pages', () => {
  captured.page.url = 'https://example.com/article'
  const html = renderToStaticMarkup(createElement(CapturePopup))
  expect(html).toContain('Add a note (optional)')
  expect(html).toContain('Capture page text')
})
