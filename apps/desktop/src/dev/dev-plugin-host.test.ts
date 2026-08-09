import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDevPluginHost, type DevPluginHost } from '@/dev/dev-plugin-host'

let host: DevPluginHost

beforeEach(() => {
  vi.useFakeTimers()
  host = createDevPluginHost()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dev plugin host', () => {
  it('runs the record then stop then read then delete session', async () => {
    await host.invoke('plugin:recording|start_recording', {
      request: { maxDurationMs: 600_000 },
    })
    await expect(host.invoke('plugin:recording|recording_status', {})).resolves.toMatchObject({
      recording: true,
    })

    vi.advanceTimersByTime(1000)
    const stop = (await host.invoke('plugin:recording|stop_recording', {})) as { path: string }
    const listed = (await host.invoke('plugin:recording|list_staged', {})) as {
      files: Array<{ path: string }>
    }
    expect(listed.files.map((file) => file.path)).toEqual([stop.path])

    await expect(
      host.invoke('plugin:recording|read_staged', { request: { path: stop.path } }),
    ).resolves.toHaveProperty('base64')
    await host.invoke('plugin:recording|delete_staged', { request: { path: stop.path } })
    await expect(host.invoke('plugin:recording|list_staged', {})).resolves.toEqual({ files: [] })
  })

  it('emits recordingLevel while recording and recordingStopped at the cap', async () => {
    const levels: unknown[] = []
    const stops: unknown[] = []
    host.listen('recording', 'recordingLevel', (payload) => {
      levels.push(payload)
    })
    host.listen('recording', 'recordingStopped', (payload) => {
      stops.push(payload)
    })

    await host.invoke('plugin:recording|start_recording', { request: { maxDurationMs: 1000 } })
    vi.advanceTimersByTime(500)
    expect(levels.length).toBeGreaterThan(0)

    vi.advanceTimersByTime(600)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({ reason: 'cap' })
    await expect(host.invoke('plugin:recording|recording_status', {})).resolves.toEqual({
      recording: false,
      elapsedMs: 0,
    })
  })

  it('holds a queued action until actions_ready and retires it on action_performed', async () => {
    const actions: unknown[] = []
    host.listen('recording', 'nativeAction', (payload) => {
      actions.push(payload)
    })

    host.queueAction('recordAudio')
    expect(actions).toEqual([])

    await host.invoke('plugin:recording|actions_ready', {})
    expect(actions).toEqual([{ action: 'recordAudio' }])

    await host.invoke('plugin:recording|action_performed', {})
    await host.invoke('plugin:recording|actions_ready', {})
    expect(actions).toHaveLength(1)
  })

  it('answers the keyboard face', async () => {
    await expect(host.invoke('plugin:keyboard|current_height', {})).resolves.toEqual({
      height: 0,
      duration: 0,
    })
    await expect(host.invoke('plugin:keyboard|impact_light', {})).resolves.toBeNull()
  })
})
