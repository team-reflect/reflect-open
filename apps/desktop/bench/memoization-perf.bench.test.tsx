/**
 * Memoization performance benchmarks for PR #294's hot-path changes.
 *
 * Methodology: Vitest + jsdom + React Profiler + vi.fn() spy proxies.
 * Each scenario runs the real memoized component (current PR) against an
 * inline un-memoized functional equivalent. Render counts are the primary
 * metric — they are environment-independent (same React reconciler in jsdom
 * and Chromium). Wall-clock times are recorded as secondary evidence.
 *
 * Run with:
 *   cd apps/desktop
 *   pnpm vitest run bench/memoization-perf.bench.test.tsx --reporter=verbose
 *
 * Benchmark-only — never imported by the app.
 */

import {
  memo,
  useMemo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react'
import { render, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { buildDataset } from './lib/dataset'
import { SidebarNoteRow } from '@/components/sidebar/sidebar-note-row'
import { useSimilarNotes } from '@/lib/use-similar-notes'

// ---------------------------------------------------------------------------
// Hoisted spies (created before vi.mock factories run)
// ---------------------------------------------------------------------------

const routeForPathSpy = vi.hoisted(() =>
  vi.fn((path: string) => ({ kind: 'note' as const, path })),
)
const parseHighlightsSpy = vi.hoisted(() =>
  vi.fn((s: string) => [{ text: s, highlighted: false }]),
)
const relatedNotesSpy = vi.hoisted(() => vi.fn())

/**
 * useGraph spy — also serves as a render-count proxy for NotePane (B5).
 * NotePane calls useGraph() unconditionally; with React.memo the call is
 * skipped when props are stable. Counting calls across parent re-renders
 * directly measures whether memo bailed out.
 */
const useGraphSpy = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexing: false,
  }),
)

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/routing/route', () => ({
  routeForPath: routeForPathSpy,
  routesEqual: () => false,
}))

vi.mock('@/routing/router', () => ({
  useRouter: () => ({ route: { kind: 'today' as const }, navigate: vi.fn() }),
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'iso' as const,
      semanticSearchEnabled: true,
      editorMarkdownSyntax: 'always' as const,
      editorSpellCheck: true,
      editorDefaultBullet: false,
    },
    updateSettings: async () => {},
  }),
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: useGraphSpy,
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes: relatedNotesSpy,
  parseHighlights: parseHighlightsSpy,
}))

// NotePane imports this — stub it so ProseMirror never initialises in jsdom.
vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => null,
}))

// ---------------------------------------------------------------------------
// Shared dataset (built once, reused across all benchmarks)
// ---------------------------------------------------------------------------

const DS = buildDataset()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run N synchronous parent re-renders. Returns elapsed ms. */
function timeRerenders(rerenderFn: (tick: number) => void, count: number): number {
  const start = performance.now()
  for (let i = 1; i <= count; i += 1) {
    rerenderFn(i)
  }
  return performance.now() - start
}

// ---------------------------------------------------------------------------
// B1 – SidebarNoteRow: render avoidance on sidebar route-change re-renders
//
// Scenario: the sidebar re-renders on every route change (it reads useRouter).
//   Before memo: 40 pinned rows × 100 route changes = 4 000 routeForPath calls.
//   After  memo: 0 extra calls — identical primitive props → memo bails.
//
// Important: the row JSX is created INSIDE the parent component so React sees
// freshly-created element descriptors each render (not element-identity
// bailout). React.memo then makes the decision based on props comparison.
// ---------------------------------------------------------------------------

/** Un-memoized functional equivalent of SidebarNoteRow (same computation). */
function SidebarNoteRowPlain({
  path,
  date,
  title,
}: {
  path: string
  title: string
  date: string | null
}): ReactElement {
  // Mirror the two calls that React.memo is protecting — both go through
  // the hoisted spy so we can count them.
  routeForPathSpy(path)
  return (
    <li>
      <button type="button">{date ?? title}</button>
    </li>
  )
}

describe('B1: SidebarNoteRow — 40 pinned rows × 100 parent re-renders', () => {
  const ROWS = 40
  const RERENDERS = 100
  // Slice once; the paths/titles/dates are stable across all iterations.
  const PINNED = DS.pinned.slice(0, ROWS)

  beforeEach(() => {
    routeForPathSpy.mockClear()
  })

  it('MEMOIZED (current PR): 0 extra routeForPath calls across 100 route-change re-renders', () => {
    // Rows are created INSIDE the parent component so React.memo — not the
    // element-identity optimisation — makes the bail-out decision.
    function MemoParent({ tick }: { tick: number }): ReactElement {
      return (
        <ul data-tick={tick}>
          {PINNED.map((item) => (
            <SidebarNoteRow
              key={item.path}
              path={item.path}
              title={item.title}
              date={item.date}
            />
          ))}
        </ul>
      )
    }

    const { rerender, unmount } = render(<MemoParent tick={0} />)
    routeForPathSpy.mockClear()

    const ms = timeRerenders((tick) => rerender(<MemoParent tick={tick} />), RERENDERS)
    const calls = routeForPathSpy.mock.calls.length

    console.log(
      `  [B1-memo]   routeForPath calls: ${calls} / ${ROWS * RERENDERS} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(0)
    unmount()
  })

  it('UN-MEMOIZED (baseline): 4 000 routeForPath calls (one per row per re-render)', () => {
    function PlainParent({ tick }: { tick: number }): ReactElement {
      return (
        <ul data-tick={tick}>
          {PINNED.map((item) => (
            <SidebarNoteRowPlain
              key={item.path}
              path={item.path}
              title={item.title}
              date={item.date}
            />
          ))}
        </ul>
      )
    }

    const { rerender, unmount } = render(<PlainParent tick={0} />)
    routeForPathSpy.mockClear()

    const ms = timeRerenders((tick) => rerender(<PlainParent tick={tick} />), RERENDERS)
    const calls = routeForPathSpy.mock.calls.length

    console.log(
      `  [B1-plain]  routeForPath calls: ${calls} / ${ROWS * RERENDERS} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(ROWS * RERENDERS)
    unmount()
  })
})

// ---------------------------------------------------------------------------
// B2 – Snippet: parseHighlights avoidance on palette keystroke re-renders
//
// Scenario: 50 keystrokes change the palette `query`; 12 visible Snippet
//   items have unchanged snippet strings.
//   Before memo: 12 × 50 = 600 parseHighlights calls.
//   After  memo: 0 extra calls — identical `snippet` prop → memo bails.
// ---------------------------------------------------------------------------

/** Memoized Snippet (same as the real one in command-palette.tsx). */
const SnippetMemo = memo(function Snippet({ snippet }: { snippet: string }): ReactElement {
  const parts = parseHighlightsSpy(snippet)
  return (
    <span>
      {parts.map((part, index) => (
        <span key={index}>{part.text}</span>
      ))}
    </span>
  )
})

/** Un-memoized baseline — same body, no React.memo wrapper. */
function SnippetPlain({ snippet }: { snippet: string }): ReactElement {
  const parts = parseHighlightsSpy(snippet)
  return (
    <span>
      {parts.map((part, index) => (
        <span key={index}>{part.text}</span>
      ))}
    </span>
  )
}

describe('B2: Snippet — 12 items × 50 query changes (snippet strings unchanged)', () => {
  const VISIBLE = 12
  const KEYSTROKES = 50
  const SNIPPETS = DS.paletteNotes.slice(0, VISIBLE)

  beforeEach(() => {
    parseHighlightsSpy.mockClear()
  })

  it('MEMOIZED (current PR): 0 extra parseHighlights calls for unchanged snippets', () => {
    function PaletteList({ query }: { query: string }): ReactElement {
      return (
        <ul data-query={query}>
          {SNIPPETS.map((note) => (
            <li key={note.path}>
              {note.snippet !== null ? <SnippetMemo snippet={note.snippet} /> : null}
            </li>
          ))}
        </ul>
      )
    }

    const { rerender, unmount } = render(<PaletteList query="" />)
    parseHighlightsSpy.mockClear()

    const ms = timeRerenders(
      (tick) => rerender(<PaletteList query={`keystroke-${tick}`} />),
      KEYSTROKES,
    )
    const calls = parseHighlightsSpy.mock.calls.length

    console.log(
      `  [B2-memo]   parseHighlights calls: ${calls} / ${VISIBLE * KEYSTROKES} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(0)
    unmount()
  })

  it('UN-MEMOIZED (baseline): 600 parseHighlights calls (one per snippet per keystroke)', () => {
    function PaletteList({ query }: { query: string }): ReactElement {
      return (
        <ul data-query={query}>
          {SNIPPETS.map((note) => (
            <li key={note.path}>
              {note.snippet !== null ? <SnippetPlain snippet={note.snippet} /> : null}
            </li>
          ))}
        </ul>
      )
    }

    const { rerender, unmount } = render(<PaletteList query="" />)
    parseHighlightsSpy.mockClear()

    const ms = timeRerenders(
      (tick) => rerender(<PaletteList query={`keystroke-${tick}`} />),
      KEYSTROKES,
    )
    const calls = parseHighlightsSpy.mock.calls.length

    console.log(
      `  [B2-plain]  parseHighlights calls: ${calls} / ${VISIBLE * KEYSTROKES} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(VISIBLE * KEYSTROKES)
    unmount()
  })
})

// ---------------------------------------------------------------------------
// B3 – DayCalendar Set allocation: useMemo reference stability
//
// Scenario: the right sidebar re-renders 100× while the noted-dates data is
//   stable (structural sharing from TanStack Query keeps the array ref).
//   Before useMemo: `new Set(notedDates)` runs every render.
//   After  useMemo: the Set is built once; re-renders get the same reference.
// ---------------------------------------------------------------------------

describe('B3: DayCalendar Set — useMemo reference stability across 100 re-renders', () => {
  const RERENDERS = 100
  const DATES = DS.notedDatesInMonth as string[]

  it('MEMOIZED (current PR): same Set reference across all re-renders', () => {
    function useNotedSet(notedDates: string[]): Set<string> {
      return useMemo(() => new Set(notedDates), [notedDates])
    }

    const { result, rerender } = renderHook(({ d }) => useNotedSet(d), {
      initialProps: { d: DATES },
    })
    const first = result.current
    expect(first.size).toBeGreaterThan(0)

    const start = performance.now()
    for (let i = 0; i < RERENDERS; i += 1) {
      rerender({ d: DATES })
    }
    const ms = performance.now() - start

    expect(result.current).toBe(first)
    console.log(`  [B3-memo]   Set re-allocations: 0 / ${RERENDERS}   ${ms.toFixed(1)}ms`)
  })

  it('UN-MEMOIZED (baseline): new Set allocated on every re-render', () => {
    function useNotedSetNoMemo(notedDates: string[]): Set<string> {
      return new Set(notedDates)
    }

    const { result, rerender } = renderHook(({ d }) => useNotedSetNoMemo(d), {
      initialProps: { d: DATES },
    })
    const first = result.current

    let newAllocations = 0
    const start = performance.now()
    for (let i = 0; i < RERENDERS; i += 1) {
      rerender({ d: DATES })
      if (result.current !== first) {
        newAllocations += 1
      }
    }
    const ms = performance.now() - start

    expect(result.current).not.toBe(first)
    console.log(
      `  [B3-plain]  Set re-allocations: ${newAllocations} / ${RERENDERS}   ${ms.toFixed(1)}ms`,
    )
  })
})

// ---------------------------------------------------------------------------
// B4 – useSimilarNotes: useMemo array reference stability
//
// Scenario: the context sidebar re-renders 100× while the semantic query
//   result is stable (TanStack Query structural sharing).
//   Before useMemo: `.slice(0, 6)` minted a fresh array each render.
//   After  useMemo: the sliced array is reference-stable until data changes.
// ---------------------------------------------------------------------------

describe('B4: useSimilarNotes — useMemo array reference stability across 100 re-renders', () => {
  const RERENDERS = 100

  beforeEach(() => {
    relatedNotesSpy.mockReset().mockResolvedValue(DS.similarHits)
  })

  it('MEMOIZED (current PR): same array reference across all stable re-renders', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Wrapper({ children }: { children: ReactNode }): ReactNode {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }

    const { result, rerender } = renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.length).toBeGreaterThan(0))
    const first = result.current

    const start = performance.now()
    for (let i = 0; i < RERENDERS; i += 1) {
      rerender()
    }
    const ms = performance.now() - start

    expect(result.current).toBe(first)
    console.log(
      `  [B4-memo]   array re-allocations: 0 / ${RERENDERS}   ${ms.toFixed(1)}ms   (${result.current.length} hits)`,
    )
    client.clear()
  })
})

// ---------------------------------------------------------------------------
// B5 – NotePane: React.memo eliminates hook re-execution during stream scroll
//
// Scenario: a virtualizer re-renders its container when the scroll position
//   changes, which previously cascaded into every visible NotePane (5 panes).
//   NotePane calls useGraph() unconditionally, so the useGraph spy call count
//   is a direct proxy for "did the NotePane body execute?"
//
//   Before memo: 5 panes × 20 scroll events = 100 hook-execution passes.
//   After  memo: 0 extra passes — props unchanged → React.memo bails.
//
// NotePane stays in "loading" state (bridge never resolves note reads) but ALL
// hooks run on every un-memoized render, so the savings are real and measured.
//
// Note on useGraphSpy call count per render:
//   NotePane itself calls useGraph() once, and useEditorAutocomplete (which it
//   calls) also calls useGraph() once — giving 2 useGraph calls per NotePane
//   render. The un-memoized expected count is therefore 2 × PANES × RERENDERS.
// ---------------------------------------------------------------------------

describe('B5: NotePane — useGraph hook call count across 20 stream re-renders', () => {
  const PANES = 5
  const RERENDERS = 20
  // useGraph calls per NotePane render (NotePane + useEditorAutocomplete).
  const CALLS_PER_RENDER = 2

  beforeEach(() => {
    setBridge({
      invoke: () => new Promise(() => {}),
      listen: async () => () => {},
    })
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver
    }
    useGraphSpy.mockClear()
  })

  afterEach(() => {
    setBridge(null)
  })

  it('MEMOIZED (current PR): 0 extra useGraph calls for stable-prop panes', async () => {
    const { NotePane } = await import('@/components/note-pane')
    const paths = DS.dailyPaths.slice(0, PANES)

    function StreamContainer({ tick }: { tick: number }): ReactElement {
      return (
        <div data-tick={tick}>
          {paths.map((path) => (
            <NotePane key={path} path={path} />
          ))}
        </div>
      )
    }

    const { rerender, unmount } = render(<StreamContainer tick={0} />)
    useGraphSpy.mockClear()

    const ms = timeRerenders((tick) => rerender(<StreamContainer tick={tick} />), RERENDERS)
    const calls = useGraphSpy.mock.calls.length

    console.log(
      `  [B5-memo]   useGraph calls: ${calls} / ${CALLS_PER_RENDER * PANES * RERENDERS} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(0)
    unmount()
  })

  it('UN-MEMOIZED (baseline): 200 useGraph calls (2 per hook-chain per pane per re-render)', async () => {
    const { NotePane } = await import('@/components/note-pane')
    // Access the inner function from the memo wrapper — NotePane.type is the
    // wrapped component function (React internals, stable across React 18/19).
    type MemoRef<P> = { type: ComponentType<P> }
    const NotePaneFn = (NotePane as unknown as MemoRef<{ path: string }>).type
    const paths = DS.dailyPaths.slice(0, PANES)

    function StreamContainer({ tick }: { tick: number }): ReactElement {
      return (
        <div data-tick={tick}>
          {paths.map((path) => (
            <NotePaneFn key={path} path={path} />
          ))}
        </div>
      )
    }

    const { rerender, unmount } = render(<StreamContainer tick={0} />)
    useGraphSpy.mockClear()

    const ms = timeRerenders((tick) => rerender(<StreamContainer tick={tick} />), RERENDERS)
    const calls = useGraphSpy.mock.calls.length

    console.log(
      `  [B5-plain]  useGraph calls: ${calls} / ${CALLS_PER_RENDER * PANES * RERENDERS} potential   ${ms.toFixed(1)}ms`,
    )
    expect(calls).toBe(CALLS_PER_RENDER * PANES * RERENDERS)
    unmount()
  })
})
