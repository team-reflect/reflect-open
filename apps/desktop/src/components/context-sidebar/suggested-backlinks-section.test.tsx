import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuggestedBacklink, SuggestedBacklinkService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { queryKeys } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SuggestedBacklinksSection } from './suggested-backlinks-section.tsx'

const getSuggestedBacklinks = vi.fn<SuggestedBacklinkService['getSuggestedBacklinks']>()
const linkMention = vi.fn<SuggestedBacklinkService['linkMention']>()

const meetingMention: SuggestedBacklink = {
  sourcePath: 'notes/meeting.md',
  sourceTitle: 'Meeting Notes',
  line: 'talked about the roadmap today',
  mention: { from: 15, to: 22, text: 'roadmap' },
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSection(path: string) {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(core.suggestedBacklinks, 'getSuggestedBacklinks').mockImplementation(
    getSuggestedBacklinks,
  )
  vi.spyOn(core.suggestedBacklinks, 'linkMention').mockImplementation(linkMention)
  return renderInApp(
    <>
      <SuggestedBacklinksSection path={path} />
      <RouteProbe />
    </>,
    { core, graph: { root: '/g', name: 'g', generation: 1 } },
  )
}

beforeEach(() => {
  getSuggestedBacklinks.mockReset()
  linkMention.mockReset().mockResolvedValue(undefined)
  sessionStorage.clear()
})

describe('SuggestedBacklinksSection', () => {
  it('renders nothing when no note mentions this one', async () => {
    getSuggestedBacklinks.mockResolvedValue([])
    const view = await renderSection('notes/roadmap.md')
    await vi.waitFor(() => {
      expect(
        view.queryClient.getQueryState(queryKeys.suggestedBacklinks.note('/g', 'notes/roadmap.md'))
          ?.status,
      ).toBe('success')
    })
    expect(view.getByText('Suggested backlinks').query()).toBeNull()
    await view.unmount()
  })

  it('surfaces a failed query as an alert', async () => {
    getSuggestedBacklinks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderSection('notes/roadmap.md')
    await expect
      .element(view.getByRole('alert'))
      .toMatchTextContent('Couldn’t load suggested backlinks.')
    await view.unmount()
  })

  it('shows each mentioning line under its source, and opens the source', async () => {
    getSuggestedBacklinks.mockResolvedValue([meetingMention])
    const view = await renderSection('notes/roadmap.md')

    await expect.element(view.getByText('Suggested backlinks')).toBeInTheDocument()
    await expect.element(view.getByText('talked about the roadmap today')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Meeting Notes', exact: true }).click()
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/meeting.md')
    await view.unmount()
  })

  it('links a mention with the check, then re-reads the list', async () => {
    // The service leaves out a source whose current text links here.
    getSuggestedBacklinks.mockResolvedValueOnce([meetingMention]).mockResolvedValue([])
    const view = await renderSection('notes/roadmap.md')

    await view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' }).click()

    await vi.waitFor(() => {
      expect(linkMention).toHaveBeenCalledWith(
        'notes/roadmap.md',
        'notes/meeting.md',
        meetingMention.mention,
      )
    })
    await vi.waitFor(() => {
      expect(view.getByText('Suggested backlinks').query()).toBeNull()
    })
    expect(getSuggestedBacklinks).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('refetches after a refused link too, so a retry uses fresh offsets', async () => {
    const moved: SuggestedBacklink = {
      ...meetingMention,
      mention: { from: 40, to: 47, text: 'roadmap' },
    }
    getSuggestedBacklinks.mockResolvedValueOnce([meetingMention]).mockResolvedValue([moved])
    linkMention.mockRejectedValueOnce(new Error('The note has changed — try again in a moment.'))
    const view = await renderSection('notes/roadmap.md')
    const link = view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' })

    await link.click()
    await vi.waitFor(() => expect(getSuggestedBacklinks).toHaveBeenCalledTimes(2))
    await expect.element(link).toBeEnabled()
    await link.click()

    await vi.waitFor(() => {
      expect(linkMention).toHaveBeenLastCalledWith(
        'notes/roadmap.md',
        'notes/meeting.md',
        moved.mention,
      )
    })
    await view.unmount()
  })

  it('says so when a re-read fails, even with a list on screen', async () => {
    getSuggestedBacklinks
      .mockResolvedValueOnce([meetingMention])
      .mockRejectedValue(new Error('index unavailable'))
    const view = await renderSection('notes/roadmap.md')

    await view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' }).click()

    await expect
      .element(view.getByRole('alert'))
      .toMatchTextContent('Couldn’t load suggested backlinks.')
    await view.unmount()
  })

  it('settles a link made on another note, re-reading the list on screen', async () => {
    let finishLink: () => void = () => {}
    linkMention.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishLink = resolve
      })
    })
    getSuggestedBacklinks.mockResolvedValue([meetingMention])
    const view = await renderSection('notes/roadmap.md')

    await view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' }).click()
    await vi.waitFor(() => expect(linkMention).toHaveBeenCalled())
    // The section unmounts (a daily note, say) and mounts afresh for the next
    // note while the write is pending.
    await view.rerender(<RouteProbe />)
    await view.rerender(<SuggestedBacklinksSection path="notes/plans.md" />)
    await vi.waitFor(() => {
      expect(getSuggestedBacklinks).toHaveBeenCalledWith('notes/plans.md')
    })
    // The pending write may move this list's offsets, so it can't link yet.
    const plansLink = view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' })
    await expect.element(plansLink).toBeDisabled()

    finishLink()
    // The link has settled, callbacks included.
    await vi.waitFor(() => expect(view.queryClient.isMutating()).toBe(0))

    // The list on screen was re-read, and links again.
    expect(
      getSuggestedBacklinks.mock.calls.filter(([path]) => path === 'notes/plans.md'),
    ).toHaveLength(2)
    await expect.element(plansLink).toBeEnabled()
    // The linked note's list was forgotten, not kept stale.
    expect(
      view.queryClient.getQueryState(queryKeys.suggestedBacklinks.note('/g', 'notes/roadmap.md')),
    ).toBeUndefined()
    await view.unmount()
  })
})
