import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { AudioRecorderService } from './audio-recorder-service.ts'
import { createNativeAudioRecorder } from './native-audio-recorder.ts'
import { createWebAudioRecorder } from './web-audio-recorder.ts'

export interface PlatformAudioRecorderDeps {
  readonly platform: PlatformFacts
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * The native recorder in the mobile app, the webview recorder everywhere else.
 */
export function createPlatformAudioRecorder(deps: PlatformAudioRecorderDeps): AudioRecorderService {
  const { platform, ipc, clock, logger } = deps
  return isMobilePlatform(platform.appPlatform) || platform.surface.mobileApp
    ? createNativeAudioRecorder({ ipc, logger })
    : createWebAudioRecorder({ clock })
}
