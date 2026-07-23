import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChatSection } from './ai-chat-section'

const settings = vi.hoisted(() => ({
  current: { chatSystemPrompt: '' },
  update: vi.fn(),
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settings.current, updateSettings: settings.update }),
}))

beforeEach(() => {
  settings.current = { chatSystemPrompt: '' }
  settings.update.mockClear()
})

describe('AiChatSection', () => {
  it('persists a dirty prompt when keyboard navigation unmounts Settings before blur', async () => {
    const view = await render(<AiChatSection />)
    const textarea = view.getByRole('textbox', { name: 'System prompt' })

    await textarea.fill('  Keep answers short.  ')
    expect(settings.update).not.toHaveBeenCalled()

    await view.unmount()

    expect(settings.update).toHaveBeenCalledOnce()
    expect(settings.update).toHaveBeenCalledWith({ chatSystemPrompt: 'Keep answers short.' })
  })
})
