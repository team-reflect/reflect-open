import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/index.ts'
import { createAppInfoService, marketingVersion } from './app-info-service.ts'
describe('createAppInfoService', () => {
  it('reads the version through `app_version`', async () => {
    const ipc = createTestIpcBridgeService({ commands: { app_version: () => '1.2.3' } })

    await expect(createAppInfoService({ ipc }).version()).resolves.toBe('1.2.3')
    expect(ipc.calls()).toEqual([{ command: 'app_version', args: {} }])
  })

  it('rejects a malformed response with a parse error', async () => {
    const ipc = createTestIpcBridgeService({ commands: { app_version: () => 1 } })
    await expect(createAppInfoService({ ipc }).version()).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})
describe('marketingVersion', () => {
  it('strips the prerelease tag', () => {
    expect(marketingVersion('0.6.0-beta.6')).toBe('0.6.0')
  })

  it('strips build metadata', () => {
    expect(marketingVersion('0.6.0+20260711')).toBe('0.6.0')
  })

  it('keeps a stable version unchanged', () => {
    expect(marketingVersion('0.6.0')).toBe('0.6.0')
  })
})
