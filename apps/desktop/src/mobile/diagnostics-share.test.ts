import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticsSnapshot } from '@reflect/core'
import {
  prepareDiagnosticsShare,
  sharePreparedDiagnostics,
} from './diagnostics-share'

const snapshot: DiagnosticsSnapshot = {
  schemaVersion: 1,
  generatedAtMs: 2_000,
  appVersion: '0.7.0-beta.16',
  build: '202607231200',
  safeMode: false,
  reason: null,
  recentWebContentTerminations: 1,
  events: [
    {
      kind: 'webContentTerminated',
      atMs: 1_000,
      uptimeMs: 500,
      window: 'main',
      recentCount: 1,
    },
  ],
}

describe('diagnostics sharing', () => {
  it('prepares the bounded JSON before the user taps', () => {
    const prepared = prepareDiagnosticsShare(snapshot)
    expect(prepared.filename).toBe('reflect-diagnostics-202607231200.json')
    expect(JSON.parse(prepared.text)).toEqual(snapshot)
    expect(prepared.file?.name).toBe(prepared.filename)
  })

  it('calls navigator.share immediately with the prepared file', () => {
    const calls: string[] = []
    const share = vi.fn(() => {
      calls.push('share')
      return Promise.resolve()
    })
    const canShare = vi.fn(() => {
      calls.push('canShare')
      return true
    })
    const prepared = prepareDiagnosticsShare(snapshot)

    const pending = sharePreparedDiagnostics(prepared, { share, canShare })
    expect(calls).toEqual(['canShare', 'share'])
    expect(share).toHaveBeenCalledWith({
      title: 'Reflect diagnostics',
      files: prepared.file === null ? [] : [prepared.file],
    })
    return pending
  })

  it('falls back to the already-prepared text when file sharing is unsupported', () => {
    const share = vi.fn(() => Promise.resolve())
    const prepared = prepareDiagnosticsShare(snapshot)

    const pending = sharePreparedDiagnostics(prepared, {
      share,
      canShare: () => false,
    })
    expect(share).toHaveBeenCalledWith({
      title: 'Reflect diagnostics',
      text: prepared.text,
    })
    return pending
  })
})
