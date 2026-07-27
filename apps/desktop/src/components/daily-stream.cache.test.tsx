import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactElement, type ReactNode } from 'react'
import type { CacheSnapshot } from 'virtua'
import { setBridge } from '@reflect/core'
import { RouterProvider } from '@/routing/router'
import { todayIso } from '@/lib/dates'
import { createDayWindow } from '@/lib/day-window'
import { readDailyStreamSnapshot, saveDailyStreamSnapshot } from '@/lib/daily-stream-cache'
import '@/test-utils/locator'
import { DailyStream } from './daily-stream'

/**
 * The remount contract: virtua's size cache dies with the stream component, so
 * without persistence a back/forward return lays the window out from the flat
 * 220px estimate and the restored scroll offset lands on different days. The
 * snapshot store re-seeds the measurements, so the same offset points at the
 * same content. Rows here load tall (2000px editors) to make measured and
 * estimated layouts impossible to confuse.
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => <div style={{ height: 2000 }} data-testid="fake-editor" />,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'mdy',
      timeFormat: '12h',
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: true,
      editorSmoothCaretAnimation: false,
      editorDefaultBullet: false,
      editorBulletAfterHeading: false,
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

setBridge({
  // Note reads resolve so every mounted day measures at its real (tall)
  // height; everything else stays pending.
  invoke: (cmd: string) =>
    cmd === 'note_read' ? Promise.resolve('hello') : new Promise<never>(() => {}),
  listen: async () => () => {},
})

afterEach(async () => {
  await cleanup()
})

function StreamProviders({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  return (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <div style={{ height: 800 }}>{children}</div>
      </RouterProvider>
    </QueryClientProvider>
  )
}

/** The index of the row under the scroll container's top edge, or -1. */
function topRowIndex(container: Element): number {
  const top = container.getBoundingClientRect().top
  for (const el of container.querySelectorAll<HTMLElement>('[data-index]')) {
    const rect = el.getBoundingClientRect()
    if (rect.top <= top + 1 && rect.bottom > top + 1) {
      return Number(el.dataset['index'])
    }
  }
  return -1
}

async function waitForLoadedRows(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(document.querySelectorAll('.reflect-note-loading').length).toBe(0)
      expect(document.querySelectorAll('[data-testid=fake-editor]').length).toBeGreaterThan(0)
    },
    { timeout: 5000 },
  )
}

/**
 * Wait for the anchor's imperative scroll to finish: virtua's `scrollToIndex`
 * keeps re-pinning the target while row sizes settle, so a programmatic
 * scroll fired too early is snapped back.
 */
async function waitForStableScroll(el: Element): Promise<void> {
  await vi.waitFor(
    async () => {
      const before = el.scrollTop
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(el.scrollTop).toBe(before)
    },
    { timeout: 10_000 },
  )
}

describe('daily-stream-cache', () => {
  it('keeps a snapshot per graph root and rejects a window-anchor mismatch', () => {
    const cache = [[100, 200], 220] as unknown as CacheSnapshot
    saveDailyStreamSnapshot('/a', { cache, windowStart: '2020-01-01' })
    expect(readDailyStreamSnapshot('/a', '2020-01-01')).toBe(cache)
    expect(readDailyStreamSnapshot('/a', '2020-01-02')).toBeNull()
    expect(readDailyStreamSnapshot('/b', '2020-01-01')).toBeNull()
  })

  it(
    'remounts with its measured heights so the restored offset shows the same day',
    { timeout: 20_000 },
    async () => {
      const view = await render(
        <StreamProviders>
          <DailyStream target={{ kind: 'today' }} />
        </StreamProviders>,
      )
      const stream = page.getByTestId('daily-stream')
      await vi.waitFor(() => expect(stream.element().scrollTop).toBeGreaterThan(0))
      await waitForLoadedRows()
      await waitForStableScroll(stream.element())

      // Walk downward through several rows so the measured layout (2000px
      // rows) diverges from the estimated one (220px rows) by dozens of rows'
      // worth of offset.
      for (let step = 0; step < 3; step++) {
        stream.element().scrollTop += 3000
        await waitForLoadedRows()
        await waitForStableScroll(stream.element())
      }
      const container = stream.element()
      const indexBefore = await vi.waitFor(() => {
        const index = topRowIndex(container)
        expect(index).toBeGreaterThan(0)
        return index
      })

      // Unmount only the stream: the router (and its saved scroll offset)
      // survives, as when navigating to a note and back.
      await view.rerender(<StreamProviders>{null}</StreamProviders>)
      expect(readDailyStreamSnapshot('/g', createDayWindow(todayIso()).start)).not.toBeNull()

      await view.rerender(
        <StreamProviders>
          <DailyStream target={{ kind: 'today' }} />
        </StreamProviders>,
      )
      const remounted = page.getByTestId('daily-stream').element()
      await vi.waitFor(() => expect(remounted.scrollTop).toBeGreaterThan(0))
      await waitForLoadedRows()
      // Without the snapshot the offset lands ~2800px-per-row short and the
      // top row is off by dozens of indexes; allow one row of settle noise.
      await vi.waitFor(
        () => expect(Math.abs(topRowIndex(remounted) - indexBefore)).toBeLessThanOrEqual(1),
        { timeout: 5000 },
      )
      await view.unmount()
    },
  )
})
