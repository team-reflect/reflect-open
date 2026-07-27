import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_PREFERENCE_CACHE_KEY } from './theme-cache'

/**
 * `public/theme-init.js` is served raw — no bundler, so it cannot import the
 * cache key and has to repeat the literal. Renaming the key here without
 * updating that script would silently stop the early theme paint from finding
 * the cached preference, reverting every launch to the OS preference. Assert
 * the two agree instead.
 */
const THEME_INIT_PATH = fileURLToPath(new URL('../../public/theme-init.js', import.meta.url))

describe('THEME_PREFERENCE_CACHE_KEY', () => {
  it('matches the key the early theme script reads', () => {
    const script = readFileSync(THEME_INIT_PATH, 'utf8')
    expect(script).toContain(`'${THEME_PREFERENCE_CACHE_KEY}'`)
  })
})
