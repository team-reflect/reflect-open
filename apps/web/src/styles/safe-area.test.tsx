import { afterEach, describe, expect, it } from 'vitest'

const root = document.documentElement

function styleOf(className: string, property: string): number {
  const probe = document.createElement('div')
  probe.className = className
  document.body.append(probe)
  const value = Number.parseFloat(getComputedStyle(probe).getPropertyValue(property))
  probe.remove()
  return value
}

describe('safe-area utilities', () => {
  afterEach(() => {
    for (const name of [
      '--twsa-safe-area-inset-top',
      '--twsa-safe-area-inset-right',
      '--keyboard-height',
      '--mobile-tab-bar-height',
      '--chrome-bottom-bar',
      '--chrome-safe-bottom',
    ]) {
      root.style.removeProperty(name)
    }
  })

  it('takes the larger of the inset and the floor', () => {
    expect(styleOf('pt-safe-or-6', 'padding-top')).toBe(24)
    root.style.setProperty('--twsa-safe-area-inset-top', '40px')
    expect(styleOf('pt-safe-or-6', 'padding-top')).toBe(40)
  })

  it('adds the offset to the inset', () => {
    root.style.setProperty('--twsa-safe-area-inset-right', '84px')
    expect(styleOf('px-safe-offset-4', 'padding-right')).toBe(100)
    expect(styleOf('px-safe-offset-4', 'padding-left')).toBe(16)
  })

  it('pads above the software keyboard', () => {
    expect(styleOf('pb-above-keyboard', 'padding-bottom')).toBe(0)
    root.style.setProperty('--keyboard-height', '300px')
    expect(styleOf('pb-above-keyboard', 'padding-bottom')).toBe(300)
  })

  it('floats above the keyboard and the bottom bar of the chrome', () => {
    root.style.setProperty('--chrome-bottom-bar', '52px')
    expect(styleOf('fixed bottom-above-chrome-offset-4', 'bottom')).toBe(68)
    root.style.setProperty('--keyboard-height', '300px')
    expect(styleOf('fixed bottom-above-chrome-offset-4', 'bottom')).toBe(368)
  })

  it('clears the safe area the chrome leaves to the page', () => {
    expect(styleOf('pb-chrome-safe-offset-24', 'padding-bottom')).toBe(96)
    root.style.setProperty('--chrome-safe-bottom', '34px')
    expect(styleOf('pb-chrome-safe-offset-24', 'padding-bottom')).toBe(130)
    expect(styleOf('pb-chrome-safe-unless-keyboard-offset-2', 'padding-bottom')).toBe(42)
    root.style.setProperty('--keyboard-height', '300px')
    expect(styleOf('pb-chrome-safe-unless-keyboard-offset-2', 'padding-bottom')).toBe(8)
  })

  it('sits above the tab bar', () => {
    expect(styleOf('fixed bottom-above-tab-bar-offset-3', 'bottom')).toBe(12)
    root.style.setProperty('--mobile-tab-bar-height', '80px')
    expect(styleOf('fixed bottom-above-tab-bar-offset-3', 'bottom')).toBe(92)
  })
})
