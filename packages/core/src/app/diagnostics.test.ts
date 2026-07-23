import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  bootstrapDiagnostics,
  diagnosticsSnapshotSchema,
  getDiagnosticsSnapshot,
  markDiagnosticsFrontendReady,
  recordDiagnosticCheckpoint,
  retryNormalDiagnosticsStartup,
} from './diagnostics'

const invoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  invoke.mockReset()
  setBridge({ invoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('diagnostics IPC', () => {
  it('uses only closed commands and checkpoint values', async () => {
    invoke
      .mockResolvedValueOnce({
        safeMode: false,
        reason: null,
        recentWebContentTerminations: 0,
      })
      .mockResolvedValue(null)

    await expect(bootstrapDiagnostics()).resolves.toEqual({
      safeMode: false,
      reason: null,
      recentWebContentTerminations: 0,
    })
    await recordDiagnosticCheckpoint('graphOpening')
    await markDiagnosticsFrontendReady()
    await retryNormalDiagnosticsStartup()

    expect(invoke.mock.calls).toEqual([
      ['diagnostics_bootstrap', {}],
      ['diagnostics_checkpoint', { checkpoint: 'graphOpening' }],
      ['diagnostics_frontend_ready', {}],
      ['diagnostics_retry_normal', {}],
    ])
  })

  it('validates the native snapshot exactly', async () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAtMs: 2_000,
      appVersion: '0.7.0-beta.16',
      build: '202607231200',
      safeMode: true,
      reason: 'repeatedWebContentTerminations',
      recentWebContentTerminations: 3,
      events: [
        {
          kind: 'webContentTerminated',
          atMs: 1_000,
          uptimeMs: 500,
          window: 'main',
          recentCount: 3,
        },
      ],
    }
    invoke.mockResolvedValue(snapshot)

    await expect(getDiagnosticsSnapshot()).resolves.toEqual(snapshot)
    expect(invoke).toHaveBeenCalledWith('diagnostics_snapshot', {})
  })

  it('rejects unexpected fields and arbitrary event text', () => {
    expect(
      diagnosticsSnapshotSchema.safeParse({
        schemaVersion: 1,
        generatedAtMs: 2_000,
        appVersion: '0.7.0',
        build: null,
        safeMode: false,
        reason: null,
        recentWebContentTerminations: 0,
        events: [
          {
            kind: 'checkpoint',
            atMs: 1_000,
            checkpoint: 'graphReady',
            noteContent: 'private note',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects unsafe version metadata from a persisted journal', () => {
    expect(
      diagnosticsSnapshotSchema.safeParse({
        schemaVersion: 1,
        generatedAtMs: 2_000,
        appVersion: 'privateNote',
        build: null,
        safeMode: false,
        reason: null,
        recentWebContentTerminations: 0,
        events: [],
      }).success,
    ).toBe(false)
  })
})
