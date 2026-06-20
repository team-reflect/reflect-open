/**
 * Real-Chromium benchmark harness for the low-IPC memoized flows (command
 * palette + sidebar pinned shelf). Mounts the REAL components with Vite-aliased
 * fake providers and a fixed large dataset, under React `<Profiler>`s, and
 * exposes `window.__bench` so the browser driver can run each flow and read
 * back real-browser commit timing, commit counts, and wall time.
 *
 * Benchmark-only. Served by `bench/web/vite.config.ts`; never part of the app.
 */

import {
  Profiler,
  StrictMode,
  useEffect,
  useState,
  type ProfilerOnRenderCallback,
  type ReactElement,
} from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setBridge } from '@reflect/core'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { SidebarNoteRow } from '@/components/sidebar/sidebar-note-row'
import { RouterProvider } from '@/routing/router'
import type { CommandContext } from '@/lib/commands/types'
import { buildDataset } from '../lib/dataset'
import '@/styles/index.css'

// A stray IPC call should never crash the harness; nothing here needs a real one.
setBridge({ invoke: async () => null, listen: async () => () => {} })

const dataset = buildDataset()

interface Meter {
  commits: number
  actualMs: number
}
const meters: Record<string, Meter> = {
  palette: { commits: 0, actualMs: 0 },
  sidebar: { commits: 0, actualMs: 0 },
}
function meterCallback(id: string): ProfilerOnRenderCallback {
  return (_id, _phase, actualDuration) => {
    const meter = meters[id]!
    meter.commits += 1
    meter.actualMs += actualDuration
  }
}

const paletteContext: CommandContext = {
  navigate: () => {},
  route: () => ({ kind: 'today' }),
  notePath: () => null,
  back: () => {},
  forward: () => {},
  toggleTheme: () => {},
  toggleSidebar: () => {},
  newChat: () => {},
  toggleAudioMemo: () => {},
  generation: () => 1,
  openPalette: () => {},
  openShortcuts: () => {},
  enableSemanticSearch: () => {},
}

function OpenPalette(): null {
  const { openPalette } = usePalette()
  useEffect(() => {
    queueMicrotask(() => openPalette('a'))
  }, [openPalette])
  return null
}

function SidebarHarness(): ReactElement {
  const [, setTick] = useState(0)
  useEffect(() => {
    const benchWindow = window as unknown as { __bumpSidebar?: () => void }
    benchWindow.__bumpSidebar = () => setTick((value) => value + 1)
    return () => {
      delete benchWindow.__bumpSidebar
    }
  }, [])
  return (
    <ul>
      {dataset.pinned.map((entry) => (
        <SidebarNoteRow key={entry.path} path={entry.path} title={entry.title} date={entry.date} />
      ))}
    </ul>
  )
}

function App(): ReactElement {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ width: 280 }}>
            <Profiler id="sidebar" onRender={meterCallback('sidebar')}>
              <SidebarHarness />
            </Profiler>
          </div>
          <div style={{ flex: 1 }}>
            <Profiler id="palette" onRender={meterCallback('palette')}>
              <PaletteProvider>
                <OpenPalette />
                <CommandPalette context={paletteContext} />
              </PaletteProvider>
            </Profiler>
          </div>
        </div>
      </RouterProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// ---- driver API -----------------------------------------------------------

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function paletteInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.reflect-palette-input')
  if (!input) throw new Error('palette input not found')
  return input
}

async function dispatchKey(target: HTMLElement, key: string): Promise<void> {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  await nextFrame()
}

const bench = {
  ready: () => document.querySelectorAll('[data-testid="bench-preview"]').length > 0,
  counts: () => ({
    paletteResults: document.querySelectorAll('.reflect-palette-item').length,
    pinnedRows: document.querySelectorAll('li button').length,
    previews: document.querySelectorAll('[data-testid="bench-preview"]').length,
  }),
  // Type `n` characters into the palette query; measures Snippet/list churn.
  async paletteType(times: number): Promise<Meter & { wallMs: number }> {
    const input = paletteInput()
    input.focus()
    const before = { ...meters.palette }
    const start = performance.now()
    for (let index = 0; index < times; index += 1) {
      const value = `a${'bcdefghijklmnop'.slice(0, index + 1)}`
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextFrame()
    }
    return {
      commits: meters.palette.commits - before.commits,
      actualMs: Number((meters.palette.actualMs - before.actualMs).toFixed(2)),
      wallMs: Number((performance.now() - start).toFixed(2)),
    }
  },
  // Move the highlight down `n` times; measures NotePreview remount churn.
  async paletteArrow(times: number): Promise<Meter & { wallMs: number }> {
    const input = paletteInput()
    input.focus()
    const before = { ...meters.palette }
    const start = performance.now()
    for (let index = 0; index < times; index += 1) {
      await dispatchKey(input, 'ArrowDown')
    }
    return {
      commits: meters.palette.commits - before.commits,
      actualMs: Number((meters.palette.actualMs - before.actualMs).toFixed(2)),
      wallMs: Number((performance.now() - start).toFixed(2)),
    }
  },
  // Re-render the sidebar `n` times (route-change-style); measures row churn.
  async sidebarRerender(times: number): Promise<Meter & { wallMs: number }> {
    const bump = (window as unknown as { __bumpSidebar?: () => void }).__bumpSidebar
    if (!bump) throw new Error('sidebar not mounted')
    const before = { ...meters.sidebar }
    const start = performance.now()
    for (let index = 0; index < times; index += 1) {
      bump()
      await nextFrame()
    }
    return {
      commits: meters.sidebar.commits - before.commits,
      actualMs: Number((meters.sidebar.actualMs - before.actualMs).toFixed(2)),
      wallMs: Number((performance.now() - start).toFixed(2)),
    }
  },
}

;(window as unknown as { __bench: typeof bench }).__bench = bench
