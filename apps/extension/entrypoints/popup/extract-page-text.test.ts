import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tryExtractPageText } from './extract-page-text.ts'

const browserMocks = vi.hoisted(() => ({
  executeScript: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock('wxt/browser', () => ({
  browser: {
    scripting: {
      executeScript: browserMocks.executeScript,
    },
    tabs: {
      sendMessage: browserMocks.sendMessage,
    },
  },
}))

vi.mock('@/lib/page-text', () => ({
  EXTRACT_PAGE_TEXT_MESSAGE_TYPE: 'reflect:capture-page-text',
  extractPageTextResponseSchema: {
    parse: (value: unknown) => value,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  browserMocks.executeScript.mockResolvedValue([])
  browserMocks.sendMessage.mockResolvedValue({ ok: true, contentText: ' Article text ' })
})

describe('tryExtractPageText', () => {
  it('returns extracted text when the content script responds', async () => {
    await expect(tryExtractPageText(42, 'https://example.com/article')).resolves.toBe(
      'Article text',
    )
    expect(browserMocks.sendMessage).toHaveBeenCalledWith(42, {
      type: 'reflect:capture-page-text',
      expectedUrl: 'https://example.com/article',
    })
  })

  it('degrades to no page text when optional extraction fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    browserMocks.sendMessage.mockRejectedValue(new Error('receiving end does not exist'))

    await expect(tryExtractPageText(42, 'https://example.com/article')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
