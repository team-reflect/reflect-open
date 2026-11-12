import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectHostKind, detectPlatformFacts } from './detect-platform.ts'

const DESKTOP_SURFACE = { touchEditor: false, mobileApp: false }
const MOBILE_SURFACE = { touchEditor: true, mobileApp: true }

const originalUrl = window.location.href

afterEach(() => {
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', originalUrl)
})

function setQuery(query: string): void {
  const url = new URL(window.location.href)
  url.search = query
  window.history.replaceState(null, '', url)
}

describe('detectPlatformFacts', () => {
  it.each(['darwin', 'windows', 'linux'])('is the desktop surface in a %s build', (env) => {
    vi.stubEnv('TAURI_ENV_PLATFORM', env)
    const facts = detectPlatformFacts('tauri')
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it('is the mobile surface in the Swift shell', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
    const facts = detectPlatformFacts('swift')
    expect(facts.appPlatform).toBe('ios')
    expect(facts.isSwiftMobile).toBe(true)
    expect(facts.surface).toEqual(MOBILE_SURFACE)
  })

  it('is the mobile surface in an android build', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'android')
    const facts = detectPlatformFacts('tauri')
    expect(facts.appPlatform).toBe('android')
    expect(facts.surface).toEqual(MOBILE_SURFACE)
  })

  it('is the desktop surface in plain-browser dev', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', '')
    const facts = detectPlatformFacts('browser')
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it.each(['ios', 'android'] as const)(
    'follows the `?platform=%s` override in plain-browser dev',
    (platform) => {
      vi.stubEnv('TAURI_ENV_PLATFORM', '')
      setQuery(`?platform=${platform}`)
      const facts = detectPlatformFacts('browser')
      expect(facts.appPlatform).toBe(platform)
      expect(facts.surface).toEqual(MOBILE_SURFACE)
    },
  )

  it('follows the `?platform=desktop` override in plain-browser dev', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', '')
    setQuery('?platform=desktop')
    expect(detectPlatformFacts('browser').surface).toEqual(DESKTOP_SURFACE)
  })

  it('ignores the override in a build with a Tauri target', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
    setQuery('?platform=ios')
    const facts = detectPlatformFacts('tauri')
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it('gives the platform its mobile surface at boot, so the mobile root sets nothing', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
    expect(detectPlatformFacts('swift').surface).toEqual(MOBILE_SURFACE)
  })
})

describe('detectHostKind', () => {
  it('is Tauri when Tauri sets `isTauri`', () => {
    expect(detectHostKind({ isTauri: true })).toBe('tauri')
  })

  it('is Swift when the Swift shell adds its script message handler', () => {
    const reflectHost = { postMessage: () => {} }
    expect(detectHostKind({ webkit: { messageHandlers: { reflectHost } } })).toBe('swift')
  })

  it('is the browser without either global', () => {
    expect(detectHostKind({})).toBe('browser')
  })
})
