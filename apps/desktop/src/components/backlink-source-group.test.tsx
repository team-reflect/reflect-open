import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BacklinkSource } from '@/lib/group-backlinks'
import { BacklinkSourceGroup } from './backlink-source-group'

const SOURCE: BacklinkSource = {
  path: 'notes/source.md',
  title: 'Source Note',
  snippets: [],
}

function mount(onOpen: (path: string, event?: { metaKey: boolean }) => void) {
  return render(
    <BacklinkSourceGroup
      source={SOURCE}
      first
      expanded={false}
      onOpen={onOpen}
      onWikilinkClick={() => {}}
      onMarkdownLinkClick={() => false}
      resolveImageUrl={() => undefined}
      resolveFileLink={() => false}
      resolveWikiEmbed={() => undefined}
      resolveFileInfo={async () => undefined}
      openAttachment={async () => {}}
      resolverRevision={0}
    />,
  )
}

afterEach(cleanup)

describe('BacklinkSourceGroup', () => {
  it('forwards the click event so ⌘-click can open a new window', () => {
    const onOpen = vi.fn()
    mount(onOpen)

    fireEvent.click(screen.getByRole('button', { name: 'Source Note' }), { metaKey: true })

    expect(onOpen).toHaveBeenCalledTimes(1)
    const [path, event] = onOpen.mock.calls[0]!
    expect(path).toBe('notes/source.md')
    expect(event?.metaKey).toBe(true)
  })

  it('plain clicks arrive without the modifier', () => {
    const onOpen = vi.fn()
    mount(onOpen)

    fireEvent.click(screen.getByRole('button', { name: 'Source Note' }))

    const [, event] = onOpen.mock.calls[0]!
    expect(event?.metaKey).toBe(false)
  })
})
