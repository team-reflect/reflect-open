import { describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService, type TestPlatformOptions } from '../testing/platform.ts'
import { createPlatformAudioRecorder } from './platform-audio-recorder.ts'

function recorderOn(platform: TestPlatformOptions) {
  return createPlatformAudioRecorder({
    platform: createTestPlatformService(platform),
    ipc: createTestIpcBridgeService(),
    clock: createTestClockService(),
    logger: createTestLoggerService(),
  })
}

describe('createPlatformAudioRecorder', () => {
  // Node has no `MediaRecorder`, so only the native recorder reports support.
  it('is the webview recorder on desktop', () => {
    expect(recorderOn({}).isSupported()).toBe(false)
  })

  it('is the native recorder on a mobile platform', () => {
    expect(recorderOn({ appPlatform: 'ios' }).isSupported()).toBe(true)
  })

  it('is the native recorder on the mobile surface', () => {
    expect(recorderOn({ surface: { mobileApp: true } }).isSupported()).toBe(true)
  })
})
