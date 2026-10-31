import { describe, expect, it, vi } from 'vitest'
import { createTestIdService, createTestSettingsService } from '../testing/index.ts'
import { createAiPromptService } from './ai-prompt-service.ts'

async function createService(initial: Parameters<typeof createTestSettingsService>[0] = {}) {
  const settings = createTestSettingsService(initial)
  const id = createTestIdService()
  const prompts = createAiPromptService({ settings, id })
  prompts.list()
  await settings.whenLoaded()
  return { settings, id, prompts }
}

describe('AiPromptService', () => {
  it('lists the saved prompts', async () => {
    const saved = { id: 'p1', label: 'Shorten', body: 'Shorten this.', mode: 'replace' as const }
    const { prompts } = await createService({ aiPrompts: [saved] })

    expect(prompts.list()).toEqual([saved])
  })

  it('adds a prompt with a fresh id after the saved ones', async () => {
    const saved = { id: 'p1', label: 'Shorten', body: 'Shorten this.', mode: 'replace' as const }
    const { prompts, id } = await createService({ aiPrompts: [saved] })

    prompts.add({ label: 'Summarize', body: 'Summarize: {{selectedText}}', mode: 'append' })

    expect(prompts.list()).toEqual([
      saved,
      {
        id: id.issued()[0],
        label: 'Summarize',
        body: 'Summarize: {{selectedText}}',
        mode: 'append',
      },
    ])
  })

  it('updates only the prompt with the given id', async () => {
    const first = { id: 'p1', label: 'Shorten', body: 'Shorten this.', mode: 'replace' as const }
    const second = { id: 'p2', label: 'Expand', body: 'Expand this.', mode: 'append' as const }
    const { prompts } = await createService({ aiPrompts: [first, second] })

    prompts.update('p2', { label: 'Expand more', body: 'Expand this a lot.', mode: 'replace' })

    expect(prompts.list()).toEqual([
      first,
      { id: 'p2', label: 'Expand more', body: 'Expand this a lot.', mode: 'replace' },
    ])
  })

  it('removes the prompt with the given id', async () => {
    const first = { id: 'p1', label: 'Shorten', body: 'Shorten this.', mode: 'replace' as const }
    const second = { id: 'p2', label: 'Expand', body: 'Expand this.', mode: 'append' as const }
    const { prompts } = await createService({ aiPrompts: [first, second] })

    prompts.remove('p1')

    expect(prompts.list()).toEqual([second])
  })

  it('persists a write and notifies subscribers', async () => {
    const { prompts, settings } = await createService()
    const listener = vi.fn()
    const unlisten = prompts.subscribe(listener)

    prompts.add({ label: 'Shorten', body: 'Shorten this.', mode: 'replace' })
    await settings.flush()

    expect(listener).toHaveBeenCalled()
    expect(settings.saves().at(-1)?.aiPrompts).toEqual(prompts.list())
    unlisten()
  })
})
