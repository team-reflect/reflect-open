import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { dailyPath, setBridge } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router'
import { todayIso } from '@/lib/dates'
import { createDayWindow, indexOfDate } from '@/lib/day-window'
import { rememberDailyPaneHeight, savedDailyPaneHeight } from '@/lib/daily-note-heights'
import '@/test-utils/locator'
import { DailyStream } from './daily-stream'

/**
 * The placeholder-height contract: a daily row that scrolls back into view
 * remounts as a loading placeholder while its note reloads. Without a height
 * memory the placeholder collapses to the minimum and the row jumps back to
 * full height when the note arrives — the visible scroll jump. With it, the
 * placeholder reserves the row's last height, so both transitions are
 * size-neutral. Reads here resolve only by hand, keeping the loading phase
 * open for assertions.
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => <div style={{ height: 1000 }} data-testid="fake-editor" />,
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

const pendingReads = new Map<string, Array<(markdown: string) => void>>()

setBridge({
  invoke: (cmd: string, args?: unknown) => {
    if (cmd === 'note_read') {
      const { path } = args as { path: string }
      return new Promise<string>((resolve) => {
        const queue = pendingReads.get(path) ?? []
        queue.push(resolve)
        pendingReads.set(path, queue)
      })
    }
    return new Promise<never>(() => {})
  },
  listen: async () => () => {},
})

async function resolveRead(path: string): Promise<void> {
  await vi.waitFor(() => expect(pendingReads.has(path)).toBe(true))
  await act(async () => {
    for (const resolve of pendingReads.get(path) ?? []) {
      resolve('hello')
    }
    pendingReads.delete(path)
  })
}

afterEach(async () => {
  await cleanup()
  pendingReads.clear()
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

function NavigateTodayProbe({
  onReady,
}: {
  onReady: (navigateToday: () => void) => void
}): null {
  const { navigate } = useRouter()
  useEffect(() => {
    onReady(() => navigate({ kind: 'today' }))
  }, [navigate, onReady])
  return null
}

describe('daily note height memory', () => {
  it('stores heights per graph root and date', () => {
    rememberDailyPaneHeight('/a', '2020-01-01', 123)
    expect(savedDailyPaneHeight('/a', '2020-01-01')).toBe(123)
    expect(savedDailyPaneHeight('/a', '2020-01-02')).toBeUndefined()
    expect(savedDailyPaneHeight('/b', '2020-01-01')).toBeUndefined()
    rememberDailyPaneHeight('/a', '2020-01-01', 456)
    expect(savedDailyPaneHeight('/a', '2020-01-01')).toBe(456)
  })

  it(
    'remounts a row at its remembered height while the note reloads',
    { timeout: 20_000 },
    async () => {
      const today = todayIso()
      const todayIndex = indexOfDate(createDayWindow(today), today)
      const todaySelector = `[data-index="${todayIndex}"]`
      let navigateToday: () => void = () => {
        throw new Error('navigate not ready')
      }
      const view = await render(
        <StreamProviders>
          <DailyStream target={{ kind: 'today' }} />
          <NavigateTodayProbe
            onReady={(run) => {
              navigateToday = run
            }}
          />
        </StreamProviders>,
      )
      const stream = page.getByTestId('daily-stream')
      await vi.waitFor(() => expect(stream.element().scrollTop).toBeGreaterThan(0))

      // Load today's note: the row grows to the 1000px editor plus chrome.
      await resolveRead(dailyPath(today))
      await vi.waitFor(() =>
        expect(
          document.querySelector(`${todaySelector} [data-testid=fake-editor]`),
        ).not.toBeNull(),
      )
      const rowBefore = document.querySelector(todaySelector)!.getBoundingClientRect().height

      // Scroll far into the past so the row unmounts; its cleanup records the
      // pane height.
      stream.element().scrollTop -= 30000
      await vi.waitFor(() => expect(document.querySelector(todaySelector)).toBeNull())
      const remembered = savedDailyPaneHeight('/g', today)
      expect(remembered).toBeGreaterThanOrEqual(1000)

      // Return to today. The note read is pending again, so the row is a
      // loading placeholder — now sized to the remembered height instead of
      // collapsing to the minimum.
      act(() => {
        navigateToday()
      })
      await vi.waitFor(() => {
        const placeholder = document.querySelector(`${todaySelector} .reflect-note-loading`)
        expect(placeholder).not.toBeNull()
        expect(placeholder!.getBoundingClientRect().height).toBeCloseTo(remembered!, 0)
      })
      expect(
        document.querySelector(todaySelector)!.getBoundingClientRect().height,
      ).toBeCloseTo(rowBefore, 0)

      // A never-loaded neighbor keeps the class-based minimum: no inline height.
      const neighbor = document.querySelector(
        `[data-index="${todayIndex - 2}"] .reflect-note-loading`,
      )
      expect(neighbor).not.toBeNull()
      expect((neighbor as HTMLElement).style.height).toBe('')
      expect(neighbor!.className).toMatch(/min-h-/)

      // The note arriving must not change the row's size: load it and compare.
      await resolveRead(dailyPath(today))
      await vi.waitFor(() =>
        expect(
          document.querySelector(`${todaySelector} [data-testid=fake-editor]`),
        ).not.toBeNull(),
      )
      expect(
        document.querySelector(todaySelector)!.getBoundingClientRect().height,
      ).toBeCloseTo(rowBefore, 0)
      await view.unmount()
    },
  )
})
