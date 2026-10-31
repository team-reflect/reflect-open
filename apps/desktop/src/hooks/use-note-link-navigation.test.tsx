import type { MaybePromise } from '@reflect/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { isModEvent } from '@meowdown/core'
import { createTestWindowService } from '@reflect/app/testing'
import { createTestCoreServices } from '@reflect/core/testing'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteLinkNavigation } from './use-note-link-navigation.ts'

// Receives the `reflect://` link of every note window a test opens.
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()

beforeEach(() => {
  openNoteWindow.mockReset().mockResolvedValue(true)
})

const ALPHA_LINK = 'reflect://note/notes%2Falpha.md'

function Links({ scopeKey }: { readonly scopeKey: string | undefined }): ReactElement {
  const openNoteLink = useNoteLinkNavigation(scopeKey)
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          openNoteLink({
            target: { kind: 'note', path: 'notes/alpha.md' },
            openInNewWindow: isModEvent(event),
          })
        }}
      >
        Alpha
      </button>
      <button
        type="button"
        onClick={(event) => {
          openNoteLink({
            target: { kind: 'note', path: 'notes/bravo.md' },
            openInNewWindow: isModEvent(event),
          })
        }}
      >
        Bravo
      </button>
    </>
  )
}

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function ReopenCurrentRoute(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate({ kind: 'allNotes', tag: null })}>
      Reopen current route
    </button>
  )
}

interface HarnessProps {
  readonly scopeKey?: string
  readonly visible?: boolean
}

function Harness({ scopeKey, visible = true }: HarnessProps): ReactElement {
  return (
    <>
      {visible ? <Links scopeKey={scopeKey} /> : null}
      <ReopenCurrentRoute />
      <RouteProbe />
    </>
  )
}

/**
 * Render `ui` on the All Notes route of an app whose note windows go to `openNoteWindow`.
 */
async function mount(ui: ReactElement) {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  return await renderInApp(ui, {
    core,
    appServices: { window: createTestWindowService({ openNoteWindow }) },
    route: { kind: 'allNotes', tag: null },
  })
}

function route(view: Awaited<ReturnType<typeof mount>>): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

/** Lets a settled fallback promise run its continuation (and any React flush it would cause). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('useNoteLinkNavigation', () => {
  it('navigates a plain click in the current window', async () => {
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click()

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
    expect(openNoteWindow).not.toHaveBeenCalled()
  })

  it('opens a modifier-click in a secondary window without navigating', async () => {
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledWith(ALPHA_LINK))
    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('falls back to current-window navigation when a secondary window is declined', async () => {
    openNoteWindow.mockResolvedValue(false)
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
  })

  it('falls back to current-window navigation when a secondary window open rejects', async () => {
    openNoteWindow.mockRejectedValue(new Error('window creation failed'))
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
  })

  it('does not let an older failed open override a newer note-link intent', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Bravo' }).click()
    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/bravo.md' })

    pendingOpen.resolve(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'note', path: 'notes/bravo.md' })
  })

  it('does not let an older rejected open override a newer note-link intent', async () => {
    let rejectOpen: (cause: Error) => void = () => {}
    openNoteWindow
      .mockImplementationOnce(() => {
        return new Promise((_resolve, reject) => {
          rejectOpen = reject
        })
      })
      .mockResolvedValueOnce(true)
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Bravo' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(2))

    rejectOpen(new Error('window creation failed'))
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after another control re-navigates to the same route', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Reopen current route' }).click()
    pendingOpen.resolve(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after the host surface changes scope', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await mount(<Harness scopeKey="2026-07-10" />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.rerender(<Harness scopeKey="2026-07-11" />)
    pendingOpen.resolve(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not navigate after the link host unmounts', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await mount(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['ControlOrMeta'] })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.rerender(<Harness visible={false} />)
    pendingOpen.resolve(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })
})
