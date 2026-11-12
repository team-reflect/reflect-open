import { describe, expect, it, vi } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { AiChatSection } from './ai-chat-section.tsx'

describe('AiChatSection', () => {
  it('persists a dirty prompt when keyboard navigation unmounts Settings before blur', async () => {
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const update = vi.spyOn(core.settings, 'update')
    const view = await renderInApp(<AiChatSection />, { core, settings: { chatSystemPrompt: '' } })
    const textarea = view.getByRole('textbox', { name: 'System prompt' })

    await textarea.fill('  Keep answers short.  ')
    expect(update).not.toHaveBeenCalled()

    await view.unmount()

    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith({ chatSystemPrompt: 'Keep answers short.' })
  })
})
