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
    const invoke = bridgeReturning(null)
    await startRecording({ maxDurationMs: 600_000 })
    expect(invoke).toHaveBeenCalledWith('plugin:recording|start_recording', {
      request: { maxDurationMs: 600_000 },
    })
  })

  it('stop_recording returns the staged file description', async () => {
    bridgeReturning({ path: '/staging/a.m4a', durationMs: 1200, modifiedMs: 1_700_000_000_000 })
    await expect(stopRecording()).resolves.toEqual({
      path: '/staging/a.m4a',
      durationMs: 1200,
      modifiedMs: 1_700_000_000_000,
    })
  })

  it('list_staged unwraps the files array and read_staged the base64', async () => {
    const invoke = bridgeReturning({ files: [{ path: '/staging/a.m4a', modifiedMs: 1 }] })
    await expect(listStaged()).resolves.toEqual([{ path: '/staging/a.m4a', modifiedMs: 1 }])

    invoke.mockResolvedValue({ base64: 'QUFB' })
    await expect(readStaged('/staging/a.m4a')).resolves.toBe('QUFB')
    expect(invoke).toHaveBeenLastCalledWith('plugin:recording|read_staged', {
      request: { path: '/staging/a.m4a' },
    })
  })
})
