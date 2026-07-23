import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator'
import { SETTINGS_SECTIONS, settingsSectionDomId } from './sections'
import { SettingsNavigator } from './settings-navigator'

// No bridge is installed here, so the platform-gated entries are hidden
// (Integrations needs the Rust contacts answer; Agents needs `isMacosDesktop`,
// which requires a Tauri webview) — the navigator lists the sections every
// platform shows.
const VISIBLE_SECTIONS = SETTINGS_SECTIONS.filter(
  (section) => section.id !== 'integrations' && section.id !== 'agents',
)

/**
 * Real page geometry: the scroll container is an 800px viewport whose content
 * starts with the page's 32px top padding and stacks one 500px section per
 * visible entry. The navigator is absolutely positioned so the section tops
 * stay at `sectionTop(index)` in content coordinates.
 */
const VIEWPORT_PX = 800
const SECTION_STRIDE_PX = 500
const PAGE_PADDING_PX = 32
const CONTENT_PX = PAGE_PADDING_PX + VISIBLE_SECTIONS.length * SECTION_STRIDE_PX

function sectionTop(index: number): number {
  return PAGE_PADDING_PX + index * SECTION_STRIDE_PX
}

async function renderNavigatorPage(): Promise<HTMLElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <div data-testid="scroller" style={{ overflowY: 'auto', height: VIEWPORT_PX }}>
        <div style={{ position: 'relative', paddingTop: PAGE_PADDING_PX }}>
          <div style={{ position: 'absolute', top: 0, left: 0 }}>
            <SettingsNavigator />
          </div>
          {VISIBLE_SECTIONS.map((section) => (
            <section
              key={section.id}
              id={settingsSectionDomId(section.id)}
              style={{ height: SECTION_STRIDE_PX }}
            />
          ))}
        </div>
      </div>
    </QueryClientProvider>,
  )
  return view.getByTestId('scroller').element() as HTMLElement
}

function scrollPageTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top
}

function activeEntry() {
  return page.locate('button[aria-current="location"]')
}

describe('SettingsNavigator', () => {
  it('lists every visible section in order', async () => {
    await renderNavigatorPage()
    const labels = page.getByRole('button').elements().map((button) => button.textContent)
    expect(labels).toEqual(VISIBLE_SECTIONS.map((section) => section.title))
  })

  it('marks the section under the reading line as the page scrolls', async () => {
    const scroller = await renderNavigatorPage()
    await expect.element(activeEntry()).toHaveTextContent('Appearance')

    // Scroll until the Editor section (index 1) sits at the jump offset.
    scrollPageTo(scroller, sectionTop(1) - PAGE_PADDING_PX)
    await expect.element(activeEntry()).toHaveTextContent('Editor')

    scrollPageTo(scroller, 0)
    await expect.element(activeEntry()).toHaveTextContent('Appearance')
  })

  it('hands the last section the marker at the very bottom of the page', async () => {
    const scroller = await renderNavigatorPage()
    scrollPageTo(scroller, CONTENT_PX - VIEWPORT_PX)
    // Danger zone's top never crosses the reading line, but the page can scroll no
    // further — the bottom override keeps the last entry reachable.
    await expect.element(activeEntry()).toHaveTextContent('Danger zone')
  })

  it('clicking an entry scrolls its section to the top of the page', async () => {
    const scroller = await renderNavigatorPage()
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo

    await page.getByRole('button', { name: 'Editor' }).click()

    // The browser project runs with `reducedMotion: 'reduce'`, so the jump
    // asks for an instant scroll instead of a smooth one.
    expect(scrollTo).toHaveBeenCalledWith({
      top: sectionTop(1) - PAGE_PADDING_PX,
      behavior: 'auto',
    })
  })
})
