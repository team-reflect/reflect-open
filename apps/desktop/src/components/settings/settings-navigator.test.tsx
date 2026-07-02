import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_SECTIONS, settingsSectionDomId } from './sections'
import { SettingsNavigator } from './settings-navigator'

// No bridge is installed here, so the platform-gated System integrations entry
// is hidden — the navigator lists the sections every platform shows.
const VISIBLE_SECTIONS = SETTINGS_SECTIONS.filter((section) => section.id !== 'integrations')

// jsdom implements neither; the navigator re-measures its marker on resize,
// and the jump checks the reduced-motion preference.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
window.matchMedia ??= (query: string): MediaQueryList => ({
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
 * 32px top padding. jsdom does no layout, so the scroller's metrics and every
 * section's `getBoundingClientRect` are stubbed in terms of `scrollTop`.
 */
const VIEWPORT_PX = 800
const CONTENT_PX = 4100
const SECTION_STRIDE_PX = 500
const PAGE_PADDING_PX = 32

function sectionTop(index: number): number {
  return PAGE_PADDING_PX + index * SECTION_STRIDE_PX
}

function renderNavigatorPage(): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <div>
          <SettingsNavigator />
          {VISIBLE_SECTIONS.map((section) => (
            <section key={section.id} id={settingsSectionDomId(section.id)} />
          ))}
        </div>
      </div>
    </QueryClientProvider>,
  )
  const scroller = view.getByTestId('scroller')

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

  VISIBLE_SECTIONS.forEach((section, index) => {
    const element = document.getElementById(settingsSectionDomId(section.id))
    if (!element) {
      throw new Error(`missing section element for ${section.id}`)
    }
    element.getBoundingClientRect = () =>
      new DOMRect(0, sectionTop(index) - scrollTop, VIEWPORT_PX, SECTION_STRIDE_PX)
  })

  // The hook computed once on mount, before this geometry existed — resync.
  fireEvent.scroll(scroller)
  return scroller
}

function scrollPageTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

function activeEntry(): string | null | undefined {
  return screen
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'location')?.textContent
}

afterEach(() => {
  cleanup() // `globals: false` disables testing-library's automatic cleanup
})

describe('SettingsNavigator', () => {
  it('lists every visible section in order', () => {
    renderNavigatorPage()
    const labels = screen.getAllByRole('button').map((button) => button.textContent)
    expect(labels).toEqual(VISIBLE_SECTIONS.map((section) => section.title))
  })

  it('marks the section under the reading line as the page scrolls', () => {
    const scroller = renderNavigatorPage()
    expect(activeEntry()).toBe('Appearance')

    // Scroll until the Editor section (index 2) sits at the jump offset.
    scrollPageTo(scroller, sectionTop(2) - PAGE_PADDING_PX)
    expect(activeEntry()).toBe('Editor')

    scrollPageTo(scroller, 0)
    expect(activeEntry()).toBe('Appearance')
  })

  it('hands the last section the marker at the very bottom of the page', () => {
    const scroller = renderNavigatorPage()
    scrollPageTo(scroller, CONTENT_PX - VIEWPORT_PX)
    // Danger zone's top never crosses the reading line, but the page can scroll no
    // further — the bottom override keeps the last entry reachable.
    expect(activeEntry()).toBe('Danger zone')
  })

  it('clicking an entry scrolls its section to the top of the page', () => {
    const scroller = renderNavigatorPage()
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo

    fireEvent.click(screen.getByRole('button', { name: 'Editor' }))

    expect(scrollTo).toHaveBeenCalledWith({
      top: sectionTop(2) - PAGE_PADDING_PX,
      behavior: 'smooth',
    })
  })
})
