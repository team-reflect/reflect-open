import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { act } from '@/test-utils/act'
import { SETTINGS_SECTIONS, settingsSectionDomId } from './sections'
import { SettingsNavigator } from './settings-navigator'

// The browser provides real ResizeObserver and matchMedia, but this test drives
// the navigator off simulated geometry (see below), so it pins both: a no-op
// ResizeObserver keeps the marker on the stubbed metrics instead of real
// layout, and matchMedia reports no reduced-motion preference so the jump uses
// smooth scrolling.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})

/**
 * Simulated page geometry: the scroll container is an 800px viewport over
 * 4100px of content, with one section every 500px starting at the page's
 * 32px top padding. The section metrics and every section's
 * `getBoundingClientRect` are stubbed in terms of `scrollTop` so the active
 * entry depends only on the simulated scroll position.
 */
const VIEWPORT_PX = 800
const CONTENT_PX = 4100
const SECTION_STRIDE_PX = 500
const PAGE_PADDING_PX = 32

function sectionTop(index: number): number {
  return PAGE_PADDING_PX + index * SECTION_STRIDE_PX
}

async function renderNavigatorPage(): Promise<HTMLElement> {
  const view = await render(
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div>
        <SettingsNavigator />
        {SETTINGS_SECTIONS.map((section) => (
          <section key={section.id} id={settingsSectionDomId(section.id)} />
        ))}
      </div>
    </div>,
  )
  const scroller = view.getByTestId('scroller').element() as HTMLElement

  let scrollTop = 0
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEWPORT_PX })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => CONTENT_PX })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, VIEWPORT_PX, VIEWPORT_PX)

  SETTINGS_SECTIONS.forEach((section, index) => {
    const element = document.getElementById(settingsSectionDomId(section.id))
    if (!element) {
      throw new Error(`missing section element for ${section.id}`)
    }
    element.getBoundingClientRect = () =>
      new DOMRect(0, sectionTop(index) - scrollTop, VIEWPORT_PX, SECTION_STRIDE_PX)
  })

  // The hook computed once on mount, before this geometry existed — resync.
  await act(() => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  return scroller
}

async function scrollPageTo(scroller: HTMLElement, top: number): Promise<void> {
  scroller.scrollTop = top
  await act(() => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

function activeEntry(): string | null | undefined {
  return page
    .getByRole('button')
    .elements()
    .find((button) => button.getAttribute('aria-current') === 'location')?.textContent
}

describe('SettingsNavigator', () => {
  it('lists every registered section in order', async () => {
    await renderNavigatorPage()
    const labels = page
      .getByRole('button')
      .elements()
      .map((button) => button.textContent)
    expect(labels).toEqual(SETTINGS_SECTIONS.map((section) => section.title))
  })

  it('marks the section under the reading line as the page scrolls', async () => {
    const scroller = await renderNavigatorPage()
    expect(activeEntry()).toBe('Appearance')

    // Scroll until the Editor section (index 2) sits at the jump offset.
    await scrollPageTo(scroller, sectionTop(2) - PAGE_PADDING_PX)
    expect(activeEntry()).toBe('Editor')

    await scrollPageTo(scroller, 0)
    expect(activeEntry()).toBe('Appearance')
  })

  it('hands the last section the marker at the very bottom of the page', async () => {
    const scroller = await renderNavigatorPage()
    await scrollPageTo(scroller, CONTENT_PX - VIEWPORT_PX)
    // Danger zone's top never crosses the reading line, but the page can scroll no
    // further — the bottom override keeps the last entry reachable.
    expect(activeEntry()).toBe('Danger zone')
  })

  it('clicking an entry scrolls its section to the top of the page', async () => {
    const scroller = await renderNavigatorPage()
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo

    await userEvent.click(page.getByRole('button', { name: 'Editor', exact: true }))

    expect(scrollTo).toHaveBeenCalledWith({
      top: sectionTop(2) - PAGE_PADDING_PX,
      behavior: 'smooth',
    })
  })
})
