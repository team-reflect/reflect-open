import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuggestedBacklink, SuggestedBacklinkService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
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
    await vi.waitFor(() => expect(getSuggestedBacklinks).toHaveBeenCalled())
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

  it('links a mention with the check and drops its source at once', async () => {
    getSuggestedBacklinks.mockResolvedValue([meetingMention])
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
    expect(getSuggestedBacklinks).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('refetches after a refused link too, so a retry uses fresh offsets', async () => {
    getSuggestedBacklinks.mockResolvedValue([meetingMention])
    linkMention.mockRejectedValue(new Error('The note has changed — try again in a moment.'))
    const view = await renderSection('notes/roadmap.md')

    await view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' }).click()

    await vi.waitFor(() => expect(getSuggestedBacklinks).toHaveBeenCalledTimes(2))
    await view.unmount()
  })

  it('applies a link that settles after navigating to the note it was made on', async () => {
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
    // The sidebar is reused for the next note while the write is pending.
    await view.rerender(<SuggestedBacklinksSection path="notes/plans.md" />)
    await vi.waitFor(() => {
      expect(getSuggestedBacklinks).toHaveBeenCalledWith('notes/plans.md')
    })
    const plansLink = view.getByRole('button', { name: 'Link “roadmap” in Meeting Notes' })
    await expect.element(plansLink).toBeEnabled()

    finishLink()
    // Let the settled write's callbacks run before looking.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The other note's suggestion from the same source survives the outcome.
    await expect.element(plansLink).toBeInTheDocument()
    await view.unmount()
  })
})
