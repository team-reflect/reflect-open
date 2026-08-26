import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from './bridge'
import { listStaged, readStaged, startRecording, stopRecording } from './recording-plugin'

afterEach(() => {
  setBridge(null)
})

function bridgeReturning(response: unknown) {
  const invoke = vi.fn().mockResolvedValue(response)
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

describe('recording plugin bindings', () => {
  it('start_recording wraps the options in the request parameter', async () => {
    const invoke = bridgeReturning({ sessionStartedMs: 1_700_000_000_000 })
    await expect(
      startRecording({ segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 }),
    ).resolves.toEqual({ sessionStartedMs: 1_700_000_000_000 })
    expect(invoke).toHaveBeenCalledWith('plugin:recording|start_recording', {
      request: { segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 },
    })
  })

  it('stop_recording returns the session and its final segment', async () => {
    bridgeReturning({
      path: '/staging/a.part-002-end.m4a',
      sessionStartedMs: 1_700_000_000_000,
      part: 2,
      durationMs: 1200,
    })
    await expect(stopRecording()).resolves.toEqual({
      path: '/staging/a.part-002-end.m4a',
      sessionStartedMs: 1_700_000_000_000,
      part: 2,
      durationMs: 1200,
    })
  })

  it('list_staged unwraps the files array and read_staged the base64', async () => {
    const staged = {
      path: '/staging/a.part-001.m4a',
      sessionStartedMs: 1_700_000_000_000,
      part: 1,
      end: false,
      modifiedMs: 1,
    }
    const invoke = bridgeReturning({ files: [staged] })
    await expect(listStaged()).resolves.toEqual([staged])

    invoke.mockResolvedValue({ base64: 'QUFB' })
    await expect(readStaged('/staging/a.m4a')).resolves.toBe('QUFB')
    expect(invoke).toHaveBeenLastCalledWith('plugin:recording|read_staged', {
      request: { path: '/staging/a.m4a' },
    })
  })
})
