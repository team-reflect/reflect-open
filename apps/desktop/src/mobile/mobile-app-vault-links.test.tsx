import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import {
  chooseAmbiguousNote,
  settleAmbiguousNoteChoice,
} from '@/editor/ambiguous-note-chooser-store'

vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({
    open,
    title,
    children,
  }: {
    open?: boolean
    title?: string
    children?: ReactNode
  }) => (open ? <div role="dialog" aria-label={title}>{children}</div> : null),
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input aria-label={placeholder} />
  ),
  CommandList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading?: string; children?: ReactNode }) => (
    <section aria-label={heading}>{children}</section>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode
    onSelect?: () => void
  }) => <button type="button" onClick={onSelect}>{children}</button>,
}))

vi.mock('@/mobile/mobile-shell', async () => {
  const { useAttachmentCatalog } = await import('@/providers/attachment-catalog-provider')
  return {
    MobileShell: () => {
      const catalog = useAttachmentCatalog()
      const outcome = catalog?.resolve({
        sourcePath: 'Projects/Plan.md',
        reference: 'diagram.png',
        referenceKind: 'wikiEmbed',
      })
      return <output data-testid="attachment-outcome">{JSON.stringify(outcome)}</output>
    },
  }
})

vi.mock('@/mobile/mobile-error-boundary', () => ({
  MobileErrorBoundary: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/mobile/status-layer', () => ({ MobileStatusLayer: () => null }))
vi.mock('@/mobile/recording-drawer', () => ({ RecordingDrawer: () => null }))
vi.mock('@/mobile/use-icloud-refresh', () => ({ useICloudRefresh: () => {} }))
vi.mock('@/mobile/use-keyboard', () => ({
  useKeyboardCaretReveal: () => {},
  useKeyboardHeightVar: () => {},
}))
vi.mock('@/mobile/use-task-haptics', () => ({ useTaskCheckboxHaptics: () => {} }))

vi.mock('@/mobile/audio-memo-provider', () => ({
  MobileAudioMemoProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/providers/capture-provider', () => ({
  CaptureProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/providers/chat-provider', () => ({
  ChatProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/providers/sync-provider', () => ({
  SyncProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/routing/router', () => ({
  RouterProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    status: 'ready',
    graph: { root: '/vault', name: 'Vault', generation: 9 },
    error: null,
    needsOnboarding: false,
  }),
}))

const { MobileApp } = await import('./mobile-app')

beforeEach(() => {
  settleAmbiguousNoteChoice(null)
  setBridge({
    invoke: async (command) =>
      command === 'list_attachments'
        ? [{ path: 'Media/diagram.png', size: 8, modifiedMs: 1 }]
        : null,
    listen: async () => () => {},
  })
})

afterEach(() => {
  cleanup()
  settleAmbiguousNoteChoice(null)
  setBridge(null)
})

describe('MobileApp vault links', () => {
  it('provides the generation-scoped attachment catalog to mobile screens', async () => {
    const view = render(<MobileApp />)

    await waitFor(() => {
      expect(view.getByTestId('attachment-outcome').textContent).toBe(
        JSON.stringify({
          kind: 'resolved',
          path: 'Media/diagram.png',
          renderKind: 'image',
        }),
      )
    })
  })

  it('shows the shared duplicate-note chooser above the mobile shell', async () => {
    const view = render(<MobileApp />)

    await act(async () => {
      void chooseAmbiguousNote('Plan', ['Work/Plan.md', 'Personal/Plan.md'])
    })

    expect(view.getByRole('dialog', { name: 'Choose “Plan”' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'PlanPersonal' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'PlanWork' })).toBeTruthy()
  })
})
