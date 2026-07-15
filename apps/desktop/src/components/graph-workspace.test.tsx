import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { GraphInfo } from '@reflect/core'
import {
  chooseAmbiguousNote,
  settleAmbiguousNoteChoice,
} from '@/editor/ambiguous-note-chooser-store'

vi.mock('@/components/command-palette/palette-provider', () => ({
  PaletteProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/note-window-content', () => ({
  NoteWindowContent: () => <div data-testid="note-window-content" />,
}))
vi.mock('@/components/workspace-content', () => ({
  WorkspaceContent: () => <div data-testid="workspace-content" />,
}))
vi.mock('@/lib/windows/initial-window-route', () => ({
  getInitialWindowRoute: () => null,
}))
vi.mock('@/lib/windows/window-role', () => ({ isMainWindow: () => false }))
vi.mock('@/providers/asset-describe-provider', () => ({
  AssetDescribeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/attachment-catalog-provider', () => ({
  AttachmentCatalogProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/audio-memo-provider', () => ({
  AudioMemoProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/capture-provider', () => ({
  CaptureProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/chat-provider', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/deep-link-provider', () => ({
  DeepLinkProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/focused-daily-provider', () => ({
  FocusedDailyProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/note-templates-provider', () => ({
  NoteTemplatesProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/shortcuts-provider', () => ({
  ShortcutsProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/sidebar-provider', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/sync-provider', () => ({
  SyncProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/providers/v1-import-provider', () => ({
  V1ImportProvider: ({ children }: { children: ReactNode }) => children,
}))

import { GraphWorkspace } from './graph-workspace'

const GRAPH: GraphInfo = { root: '/vault', name: 'Vault', generation: 4 }
const originalScrollIntoView = Element.prototype.scrollIntoView

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  settleAmbiguousNoteChoice(null)
})

afterEach(() => {
  cleanup()
  settleAmbiguousNoteChoice(null)
  vi.unstubAllGlobals()
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  } else {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    })
  }
})

describe('GraphWorkspace secondary windows', () => {
  it('settles duplicate-note navigation through the shared ambiguity chooser', async () => {
    render(<GraphWorkspace graph={GRAPH} />)
    expect(screen.getByTestId('note-window-content')).toBeTruthy()
    expect(screen.queryByTestId('workspace-content')).toBeNull()

    let selection: Promise<string | null> | null = null
    act(() => {
      selection = chooseAmbiguousNote('Plan', ['Personal/Plan.md', 'Work/Plan.md'])
    })

    await userEvent.click(await screen.findByText('Work'))
    await expect(selection).resolves.toBe('Work/Plan.md')
  })
})
