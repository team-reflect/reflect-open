import { act } from '@/test-utils/act.ts'
import { isOstensiblyEmptyNoteSource } from '@reflect/core'
import {
  createTestCoreServices,
  createTestDatabaseService,
  createTestPlatformService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { NoteWindowContent } from '@/components/note-window-content.tsx'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider.tsx'
import { NoteFindProvider } from '@/providers/note-find-provider.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { SidebarProvider } from '@/providers/sidebar-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'

const GRAPH = { root: '/g', name: 'g', generation: 1 } satisfies TestOpenGraph

const NOTE_A = { kind: 'note', path: 'notes/a.md' } as const
const NOTE_B = { kind: 'note', path: 'notes/b.md' } as const

/**
 * The providers `GraphWorkspace` mounts around a note window's content.
 */
function noteWindow(children: ReactNode): ReactElement {
  return (
    <PaletteProvider>
      <ShortcutsProvider>
        <NoteTemplatesProvider>
          <SidebarProvider>
            <FocusedDailyProvider>
              <NoteFindProvider>
                <NoteWindowContent />
                {children}
              </NoteFindProvider>
            </FocusedDailyProvider>
          </SidebarProvider>
        </NoteTemplatesProvider>
      </ShortcutsProvider>
    </PaletteProvider>
  )
}

/**
 * Renders a macOS note window on `NOTE_A`, then navigates it to `NOTE_B`.
 */
async function renderNoteWindowWithHistory() {
  const readSource = (): Promise<string> => Promise.resolve('# A\n')
  const core = createTestCoreServices({
    role: 'note-window',
    database: createTestDatabaseService(),
    platform: createTestPlatformService({
      isNativeShell: true,
      isMacosDesktop: true,
      isApplePlatform: MOD_KEY.metaKey,
    }),
    noteDocuments: {
      readSource,
      readExisting: readSource,
      commitFrontmatter: () => Promise.resolve(),
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
  })
  const rendered = await renderHookInApp(
    () => ({ state: useRouterState(), actions: useRouterActions() }),
    { core, graph: GRAPH, route: NOTE_A, wrapper: noteWindow },
  )
  expect(rendered.appServices.window.isMainWindow()).toBe(false)
  await act(() => rendered.result.current.actions.navigate(NOTE_B))
  expect(rendered.result.current.state.route).toEqual(NOTE_B)
  return rendered
}

/**
 * Dispatches a cancelable Mod+`key` keydown on the window and returns it.
 */
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, ...MOD_KEY, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('note window history', () => {
  it('⌘[ and ⌘] traverse the note window’s own history', async () => {
    const { result } = await renderNoteWindowWithHistory()

    const back = await act(() => press('['))
    // A consumed key equivalent never reaches the macOS menu, whose actions
    // run in the main window.
    expect(back.defaultPrevented).toBe(true)
    expect(result.current.state.route).toEqual(NOTE_A)

    const forward = await act(() => press(']'))
    expect(forward.defaultPrevented).toBe(true)
    expect(result.current.state.route).toEqual(NOTE_B)
  })

  it('runs the history menu commands routed to the note window', async () => {
    const { result, appServices } = await renderNoteWindowWithHistory()
    const menuEvent = 'reflect://menu-command'
    onTestFinished(appServices.nativeMenu.connect())

    await act(() => appServices.window.emitWindowEvent(menuEvent, 'history.back'))
    expect(result.current.state.route).toEqual(NOTE_A)

    await act(() => appServices.window.emitWindowEvent(menuEvent, 'history.forward'))
    expect(result.current.state.route).toEqual(NOTE_B)

    // App-wide commands have their handlers in the main window.
    await act(() => appServices.window.emitWindowEvent(menuEvent, 'note.new'))
    expect(result.current.state.route).toEqual(NOTE_B)
    expect(appServices.window.emitted()).toEqual([
      { label: 'main', event: menuEvent, payload: 'note.new' },
    ])
  })
})
