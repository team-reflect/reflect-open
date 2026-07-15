import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

afterEach(cleanup)

describe('AiChatSection', () => {
  it('persists a dirty prompt when keyboard navigation unmounts Settings before blur', () => {
    const view = render(<AiChatSection />)
    const textarea = screen.getByRole('textbox', { name: 'System prompt' })

    fireEvent.change(textarea, { target: { value: '  Keep answers short.  ' } })
    expect(settings.update).not.toHaveBeenCalled()

    view.unmount()

    expect(settings.update).toHaveBeenCalledOnce()
    expect(settings.update).toHaveBeenCalledWith({ chatSystemPrompt: 'Keep answers short.' })
  })
})
