import { appleFileSrc, type FileSrcSource } from '../ports/file-src.ts'
import type {
  AppPlatform,
  BuildPlatform,
  PlatformFacts,
  PlatformSurface,
} from '../ports/platform-facts.ts'

export interface TestPlatformOptions extends Partial<Omit<PlatformFacts, 'surface'>> {
  surface?: Partial<PlatformSurface>
}

/**
 * Platform facts that also answer the file URL.
 */
export type TestPlatformService = PlatformFacts & FileSrcSource

class TestPlatformServiceImpl implements TestPlatformService {
  readonly appPlatform: AppPlatform
  readonly isNativeShell: boolean
  readonly buildPlatform: BuildPlatform | null
  readonly isMacosDesktop: boolean
  readonly isApplePlatform: boolean
  readonly hasMacosTitleBarOverlay: boolean
  readonly surface: PlatformSurface
  readonly isDev: boolean
  readonly appVersion: string

  constructor(options: TestPlatformOptions) {
    this.appPlatform = options.appPlatform ?? 'desktop'
    this.isNativeShell = options.isNativeShell ?? true
    this.buildPlatform = options.buildPlatform ?? 'darwin'
    this.isMacosDesktop = options.isMacosDesktop ?? true
    this.isApplePlatform = options.isApplePlatform ?? true
    this.hasMacosTitleBarOverlay = options.hasMacosTitleBarOverlay ?? true
    this.surface = {
      touchEditor: options.surface?.touchEditor ?? false,
      mobileApp: options.surface?.mobileApp ?? false,
    }
    this.isDev = options.isDev ?? false
    this.appVersion = options.appVersion ?? '0.0.0-test'
  }

  convertFileSrc(filePath: string, protocol: string): string {
    return appleFileSrc(filePath, protocol)
  }
}

/**
 * A test platform with fixed facts; defaults to a macOS desktop native shell.
 */
export function createTestPlatformService(options: TestPlatformOptions = {}): TestPlatformService {
  return new TestPlatformServiceImpl(options)
}
