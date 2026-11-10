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
    const facts = detectPlatformFacts(true)
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it.each(['ios', 'android'] as const)('is the mobile surface in an %s build', (env) => {
    vi.stubEnv('TAURI_ENV_PLATFORM', env)
    const facts = detectPlatformFacts(true)
    expect(facts.appPlatform).toBe(env)
    expect(facts.surface).toEqual(MOBILE_SURFACE)
  })

  it('is the desktop surface in plain-browser dev', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', '')
    const facts = detectPlatformFacts(false)
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it.each(['ios', 'android'] as const)(
    'follows the `?platform=%s` override in plain-browser dev',
    (platform) => {
      vi.stubEnv('TAURI_ENV_PLATFORM', '')
      setQuery(`?platform=${platform}`)
      const facts = detectPlatformFacts(false)
      expect(facts.appPlatform).toBe(platform)
      expect(facts.surface).toEqual(MOBILE_SURFACE)
    },
  )

  it('follows the `?platform=desktop` override in plain-browser dev', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', '')
    setQuery('?platform=desktop')
    expect(detectPlatformFacts(false).surface).toEqual(DESKTOP_SURFACE)
  })

  it('ignores the override in a build with a Tauri target', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
    setQuery('?platform=ios')
    const facts = detectPlatformFacts(true)
    expect(facts.appPlatform).toBe('desktop')
    expect(facts.surface).toEqual(DESKTOP_SURFACE)
  })

  it('gives the platform its mobile surface at boot, so the mobile root sets nothing', () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
    expect(detectPlatformFacts(true).surface).toEqual(MOBILE_SURFACE)
  })
})

describe('detectHostKind', () => {
  it('is Tauri when Tauri sets `isTauri`', () => {
    expect(detectHostKind({ isTauri: true })).toBe('tauri')
  })

  it('is Swift when the Swift shell injects `__reflectHost`', () => {
    expect(detectHostKind({ __reflectHost: { on: () => () => {} } })).toBe('swift')
  })

  it('is the browser without either global', () => {
    expect(detectHostKind({})).toBe('browser')
  })
})
