import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import { createTestSettingsService } from '../testing/settings.ts'
import { DEFAULT_SETTINGS, type AiProviderConfig, type Settings } from './schema.ts'
import { createSettingsService } from './settings-service.ts'

function setup(stored: Record<string, unknown> = {}) {
  const ipc = createTestIpcBridgeService()
  const progress = createTestProgressPort()
  const disk = {
    stored,
    failLoad: false,
    failSaves: false,
    gateLoad: false,
    gateSaves: false,
    loadCalls: 0,
    pendingLoad: null as (() => void) | null,
    pendingSaves: [] as PromiseWithResolvers<void>[],
    attempts: [] as Settings[],
    saved: [] as Settings[],
  }
  ipc.onCommand('settings_load', async () => {
    disk.loadCalls += 1
    if (disk.failLoad) {
      throw new AppError('io', 'corrupt store')
    }
    if (disk.gateLoad) {
      await new Promise<void>((resolve) => {
        disk.pendingLoad = resolve
      })
    }
    return disk.stored
  })
  ipc.onCommand('settings_save', async (args) => {
    const document = args['settings'] as Settings
    disk.attempts.push(document)
    const shouldFail = disk.failSaves
    if (disk.gateSaves) {
      const pending = Promise.withResolvers<void>()
      disk.pendingSaves.push(pending)
      await pending.promise
    }
    if (shouldFail) {
      throw new AppError('io', 'disk full')
    }
    disk.saved.push(document)
    return null
  })
  const settings = createSettingsService({ ipc, progress })
  const releaseLoad = async (): Promise<void> => {
    await vi.waitFor(() => expect(disk.pendingLoad).not.toBeNull())
    disk.pendingLoad?.()
    disk.pendingLoad = null
  }
  return { ipc, progress, disk, settings, releaseLoad }
}

describe('createSettingsService', () => {
  it('serves defaults immediately, then the persisted document', async () => {
    const { disk, settings, releaseLoad } = setup({ editorMarkdownSyntax: 'show' })
    disk.gateLoad = true
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
    expect(settings.status()).toBe('loading')

    await releaseLoad()
    await expect(settings.whenLoaded()).resolves.toBe('loaded')
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    expect(settings.status()).toBe('loaded')
    await settings.flush()
    expect(disk.saved).toEqual([])
  })

  it('loads once and notifies subscribers when the load settles', async () => {
    const { disk, settings } = setup({ editorMarkdownSyntax: 'show' })
    const listener = vi.fn()
    settings.subscribe(listener)
    settings.get()
    await settings.whenLoaded()
    settings.get()
    expect(disk.loadCalls).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps the snapshot stable between changes', async () => {
    const { settings } = setup()
    await settings.whenLoaded()
    const before = settings.get()
    expect(settings.get()).toBe(before)
    settings.update({ editorFullWidth: true })
    expect(settings.get()).not.toBe(before)
  })

  it('normalizes an invalid persisted value to its default', async () => {
    const { settings } = setup({ editorMarkdownSyntax: 'sideways' })
    await settings.whenLoaded()
    expect(settings.get().editorMarkdownSyntax).toBe('hide')
  })

  it('an equal-but-rebuilt array value does not trigger a save', async () => {
    const { disk, settings } = setup({ allNotesFilterTags: ['book', 'person'] })
    await settings.whenLoaded()
    const before = settings.get()
    const listener = vi.fn()
    settings.subscribe(listener)

    settings.update({ allNotesFilterTags: ['book', 'person'] })
    await settings.flush()
    expect(disk.saved).toEqual([])
    expect(settings.get()).toBe(before)
    expect(listener).not.toHaveBeenCalled()

    settings.update({ allNotesFilterTags: ['book'] })
    await settings.flush()
    expect(disk.saved).toEqual([{ ...DEFAULT_SETTINGS, allNotesFilterTags: ['book'] }])
  })

  it('an equal-but-rebuilt record value does not trigger a save', async () => {
    const { disk, settings } = setup({ graphColors: { '/graphs/work': 'teal' } })
    await settings.whenLoaded()
    const before = settings.get()

    settings.update({ graphColors: { '/graphs/work': 'teal' } })
    await settings.flush()
    expect(disk.saved).toEqual([])
    expect(settings.get()).toBe(before)

    settings.update({ graphColors: { '/graphs/work': 'pink' } })
    await settings.flush()
    expect(disk.saved).toMatchObject([{ graphColors: { '/graphs/work': 'pink' } }])
  })

  it('applies an update instantly and persists the full document with unknown keys', async () => {
    const { disk, settings } = setup({ editorMarkdownSyntax: 'hide', futureKey: true })
    await settings.whenLoaded()

    settings.update({ editorMarkdownSyntax: 'show' })
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    await settings.flush()
    expect(disk.saved).toEqual([
      { ...DEFAULT_SETTINGS, editorMarkdownSyntax: 'show', futureKey: true },
    ])
    expect(disk.saved[0]).toBe(settings.get())
  })

  it('serializes rapid saves and leaves disk equal to the current document', async () => {
    const { disk, settings } = setup()
    await settings.whenLoaded()
    disk.gateSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(1))
    expect(disk.attempts[0]).toMatchObject({ editorFullWidth: false, editorMarkdownSyntax: 'show' })

    let flushed = false
    const flushing = settings.flush().then(() => {
      flushed = true
    })
    settings.update({ editorFullWidth: true })
    expect(disk.attempts).toHaveLength(1)
    disk.pendingSaves[0]?.resolve()
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(2))
    expect(flushed).toBe(false)
    disk.pendingSaves[1]?.resolve()
    await flushing

    expect(disk.attempts[1]).toMatchObject({ editorFullWidth: true, editorMarkdownSyntax: 'show' })
    expect(disk.saved).toEqual(disk.attempts)
    expect(disk.saved.at(-1)).toBe(settings.get())
  })

  it('an update racing the initial load wins and keeps unknown keys', async () => {
    const { disk, settings, releaseLoad } = setup({
      editorMarkdownSyntax: 'hide',
      futureKey: true,
    })
    disk.gateLoad = true
    settings.get()

    settings.update({ editorMarkdownSyntax: 'show' })
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    await settings.flush()
    expect(disk.attempts).toEqual([])

    await releaseLoad()
    await settings.whenLoaded()
    await settings.flush()
    expect(disk.saved).toEqual([
      { ...DEFAULT_SETTINGS, editorMarkdownSyntax: 'show', futureKey: true },
    ])
    expect(settings.get().editorMarkdownSyntax).toBe('show')
  })

  it('keeps a patch dispatched as the load settles', async () => {
    const { disk, settings, releaseLoad } = setup({
      editorMarkdownSyntax: 'hide',
      futureKey: true,
    })
    disk.gateLoad = true
    const patched = settings.whenLoaded().then(() => {
      settings.update({ editorMarkdownSyntax: 'show' })
    })
    await releaseLoad()
    await patched
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    await settings.flush()
    expect(disk.saved).toEqual([
      expect.objectContaining({ editorMarkdownSyntax: 'show', futureKey: true }),
    ])
  })

  it('compounding updates racing the initial load flush as one document', async () => {
    const { disk, settings, releaseLoad } = setup({ editorMarkdownSyntax: 'show' })
    disk.gateLoad = true
    settings.update({ editorMarkdownSyntax: 'show' })
    settings.update({ editorMarkdownSyntax: 'hide' })

    await releaseLoad()
    await settings.whenLoaded()
    await settings.flush()
    expect(disk.saved).toEqual([DEFAULT_SETTINGS])
    expect(settings.get().editorMarkdownSyntax).toBe('hide')
  })

  it('a patch racing the load that matches the disk does not save', async () => {
    const { disk, settings, releaseLoad } = setup({ editorMarkdownSyntax: 'show' })
    disk.gateLoad = true
    settings.update({ editorMarkdownSyntax: 'show' })

    await releaseLoad()
    await settings.whenLoaded()
    await settings.flush()
    expect(disk.attempts).toEqual([])
  })

  it('updateWith builds each patch from the latest settings', async () => {
    const { settings } = setup({
      aiProviders: [
        { id: 'a', provider: 'openai', model: 'gpt-5.1', keyHint: '11111' },
        { id: 'b', provider: 'openai', model: 'gpt-5', keyHint: '22222' },
      ],
    })
    await settings.whenLoaded()

    settings.updateWith((current) => ({
      aiProviders: current.aiProviders.filter((model) => model.id !== 'a'),
    }))
    settings.updateWith((current) => ({
      aiProviders: current.aiProviders.filter((model) => model.id !== 'b'),
    }))
    expect(settings.get().aiProviders).toEqual([])
  })

  it('merges disk, preload patches, and queued updaters in order', async () => {
    const persisted: AiProviderConfig = {
      id: 'a',
      provider: 'openai',
      model: 'gpt-5.1',
      keyHint: '11111',
    }
    const added: AiProviderConfig = {
      id: 'b',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      keyHint: '22222',
    }
    const { disk, settings, releaseLoad } = setup({ aiProviders: [persisted], futureKey: true })
    disk.gateLoad = true

    settings.update({ editorMarkdownSyntax: 'show' })
    settings.updateWith((current) => ({ aiProviders: [...current.aiProviders, added] }))
    settings.updateWith((current) => ({
      aiProviders: current.aiProviders.filter((provider) => provider.id !== persisted.id),
    }))
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    expect(settings.get().aiProviders).toEqual([])

    await releaseLoad()
    await settings.whenLoaded()
    expect(settings.get().aiProviders).toEqual([added])
    await settings.flush()
    expect(disk.saved).toEqual([
      expect.objectContaining({
        editorMarkdownSyntax: 'show',
        aiProviders: [added],
        futureKey: true,
      }),
    ])
  })

  it('a read-modify-write racing the initial load replays over the loaded document', async () => {
    const persisted: AiProviderConfig = {
      id: 'a',
      provider: 'openai',
      model: 'gpt-5.1',
      keyHint: '11111',
    }
    const added: AiProviderConfig = {
      id: 'b',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      keyHint: '22222',
    }
    const { disk, settings, releaseLoad } = setup({ aiProviders: [persisted] })
    disk.gateLoad = true

    settings.updateWith((current) => ({ aiProviders: [...current.aiProviders, added] }))
    expect(settings.get().aiProviders).toEqual([])
    expect(disk.attempts).toEqual([])

    await releaseLoad()
    await settings.whenLoaded()
    expect(settings.get().aiProviders).toEqual([persisted, added])
    await settings.flush()
    expect(disk.saved).toEqual([expect.objectContaining({ aiProviders: [persisted, added] })])
  })

  it('a queued read-modify-write still applies session-only when the load fails', async () => {
    const added: AiProviderConfig = {
      id: 'b',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      keyHint: '22222',
    }
    const { disk, settings } = setup()
    disk.failLoad = true
    settings.updateWith((current) => ({ aiProviders: [...current.aiProviders, added] }))

    await expect(settings.whenLoaded()).resolves.toBe('failed')
    expect(settings.get().aiProviders).toEqual([added])
    await settings.flush()
    expect(disk.attempts).toEqual([])
  })

  it('surfaces a failed load and keeps changes session-only', async () => {
    const { disk, progress, settings } = setup()
    disk.failLoad = true
    await expect(settings.whenLoaded()).resolves.toBe('failed')
    expect(settings.status()).toBe('failed')
    expect(progress.snapshot()).toMatchObject([
      { label: 'Loading settings', status: 'failed', message: 'corrupt store' },
    ])

    const listener = vi.fn()
    settings.subscribe(listener)
    settings.update({ editorMarkdownSyntax: 'show' })
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    expect(listener).toHaveBeenCalledOnce()
    await settings.flush()
    expect(disk.attempts).toEqual([])
  })

  it('reloads after a failed load and adopts the stored document', async () => {
    const { disk, settings } = setup({ editorMarkdownSyntax: 'show' })
    disk.failLoad = true
    await expect(settings.whenLoaded()).resolves.toBe('failed')
    settings.update({ editorMarkdownSyntax: 'hide' })
    const listener = vi.fn()
    settings.subscribe(listener)

    disk.failLoad = false
    await expect(settings.reload()).resolves.toBe('loaded')

    expect(settings.status()).toBe('loaded')
    expect(settings.get().editorMarkdownSyntax).toBe('show')
    expect(listener).toHaveBeenCalledOnce()
    await expect(settings.whenLoaded()).resolves.toBe('loaded')
    settings.update({ editorMarkdownSyntax: 'hide' })
    await settings.flush()
    expect(disk.saved).toEqual([expect.objectContaining({ editorMarkdownSyntax: 'hide' })])
  })

  it('stays failed when the reload fails too', async () => {
    const { disk, progress, settings } = setup()
    disk.failLoad = true
    await settings.whenLoaded()

    await expect(settings.reload()).resolves.toBe('failed')

    expect(settings.status()).toBe('failed')
    expect(disk.loadCalls).toBe(2)
    expect(progress.snapshot()).toHaveLength(2)
  })

  it('does not load again once the load succeeded', async () => {
    const { disk, settings } = setup()

    await expect(settings.reload()).resolves.toBe('loaded')

    expect(disk.loadCalls).toBe(1)
  })

  it('keeps the applied value and surfaces a failed save as an operation', async () => {
    const { disk, progress, settings } = setup()
    await settings.whenLoaded()
    disk.failSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => {
      expect(progress.snapshot()).toMatchObject([
        { label: 'Saving settings', status: 'failed', message: 'disk full' },
      ])
    })
    expect(settings.get().editorMarkdownSyntax).toBe('show')
  })

  it('retries an unconfirmed save on the next update, even to the same value', async () => {
    const { disk, progress, settings } = setup()
    await settings.whenLoaded()
    disk.failSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => expect(progress.getAll()).toHaveLength(1))
    expect(disk.saved).toEqual([])

    disk.failSaves = false
    settings.update({ editorMarkdownSyntax: 'show' })
    await settings.flush()
    expect(disk.saved).toEqual([{ ...DEFAULT_SETTINGS, editorMarkdownSyntax: 'show' }])
  })

  it('continues a queued save after an earlier save fails', async () => {
    const { disk, progress, settings } = setup()
    await settings.whenLoaded()
    disk.failSaves = true
    disk.gateSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(1))
    settings.update({ editorFullWidth: true })
    expect(disk.attempts).toHaveLength(1)

    disk.failSaves = false
    disk.pendingSaves[0]?.resolve()
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(2))
    disk.pendingSaves[1]?.resolve()
    await settings.flush()

    expect(progress.snapshot()).toMatchObject([
      { label: 'Saving settings', status: 'failed', message: 'disk full' },
    ])
    expect(disk.saved).toEqual([disk.attempts[1]])
    expect(disk.saved[0]).toBe(settings.get())
  })

  it('flush persists changes a failed save left unconfirmed', async () => {
    const { disk, progress, settings } = setup()
    await settings.whenLoaded()
    disk.failSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => expect(progress.getAll()).toHaveLength(1))
    expect(disk.saved).toEqual([])

    disk.failSaves = false
    await settings.flush()
    expect(disk.saved).toEqual([{ ...DEFAULT_SETTINGS, editorMarkdownSyntax: 'show' }])
  })

  it('flush drains a pending failure, retries, and awaits the retry', async () => {
    const { disk, settings } = setup()
    await settings.whenLoaded()
    disk.failSaves = true
    disk.gateSaves = true

    settings.update({ editorMarkdownSyntax: 'show' })
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(1))

    let flushed = false
    const flushing = settings.flush().then(() => {
      flushed = true
    })
    disk.failSaves = false
    disk.pendingSaves[0]?.resolve()
    await vi.waitFor(() => expect(disk.attempts).toHaveLength(2))
    expect(flushed).toBe(false)
    disk.pendingSaves[1]?.resolve()
    await flushing

    expect(disk.saved).toEqual([disk.attempts[1]])
    expect(disk.saved[0]).toBe(settings.get())
  })

  it('flush resolves when nothing was ever loaded', async () => {
    const { disk, settings } = setup()
    await settings.flush()
    expect(disk.loadCalls).toBe(0)
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    const { settings } = setup()
    await settings.whenLoaded()
    const listener = vi.fn()
    const unlisten = settings.subscribe(listener)
    unlisten()
    settings.update({ editorFullWidth: true })
    expect(listener).not.toHaveBeenCalled()
  })
})
describe('createTestSettingsService', () => {
  it('loads the initial document and records saves', async () => {
    const settings = createTestSettingsService({ editorFullWidth: true })
    await expect(settings.whenLoaded()).resolves.toBe('loaded')
    expect(settings.get().editorFullWidth).toBe(true)

    settings.update({ editorMarkdownSyntax: 'show' })
    await settings.flush()
    expect(settings.saves()).toEqual([
      { ...DEFAULT_SETTINGS, editorFullWidth: true, editorMarkdownSyntax: 'show' },
    ])
  })

  it('fails the next save, then recovers', async () => {
    const progress = createTestProgressPort()
    const settings = createTestSettingsService(undefined, { progress })
    await settings.whenLoaded()
    settings.failNextSave()
    settings.update({ editorMarkdownSyntax: 'show' })
    await settings.flush()
    expect(settings.saves()).toHaveLength(1)
    expect(progress.getAll()).toMatchObject([{ label: 'Saving settings', status: 'failed' }])
  })

  it('fails the load', async () => {
    const settings = createTestSettingsService({ editorFullWidth: true })
    settings.failLoad()
    await expect(settings.whenLoaded()).resolves.toBe('failed')
    expect(settings.get().editorFullWidth).toBe(false)
  })
})
