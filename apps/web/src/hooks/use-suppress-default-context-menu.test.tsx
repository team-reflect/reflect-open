import type { ReactElement, ReactNode } from 'react'
import { page, userEvent, type Locator } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { BacklinkSnippet } from '@/components/backlink-snippet.tsx'
import { ChatTurn } from '@/components/chat/chat-turn.tsx'
import { LicenseEntries } from '@/components/licenses/license-list.tsx'
import { ProtectedNoteView } from '@/components/protected-note-view.tsx'
import { Input } from '@/components/ui/input.tsx'
import type { Licenses } from '@/lib/licenses/licenses.ts'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { noop } from '@ocavue/utils'
import { useSuppressDefaultContextMenu } from './use-suppress-default-context-menu.ts'

interface HostProps {
  enabled: boolean
  children: ReactNode
}

function Host({ enabled, children }: HostProps): ReactElement {
  useSuppressDefaultContextMenu(enabled)
  return <>{children}</>
}

const LICENSES: Licenses = {
  entries: [{ name: 'alpha', ecosystem: 'npm', license: 'MIT', texts: ['mit-alpha'] }],
  texts: { 'mit-alpha': 'MIT License\n\nCopyright (c) Alpha' },
}

async function renderLicenseRow(enabled: boolean): Promise<Locator> {
  await renderInApp(
    <Host enabled={enabled}>
      <LicenseEntries licenses={LICENSES} />
    </Host>,
  )
  const row = page.getByRole('button', { name: /^alpha/ })
  await expect.element(row).toBeVisible()
  return row
}

describe('useSuppressDefaultContextMenu', () => {
  it('prevents the default menu on app chrome', async () => {
    expect(fireEvent.contextMenu(await renderLicenseRow(true))).toBe(false)
  })

  it('keeps the default menu everywhere while disabled', async () => {
    expect(fireEvent.contextMenu(await renderLicenseRow(false))).toBe(true)
  })

  it('keeps the default menu on selectable license text', async () => {
    await userEvent.click(await renderLicenseRow(true))
    const text = page.getByText('Copyright (c) Alpha')
    await expect.element(text).toBeVisible()
    expect(fireEvent.contextMenu(text)).toBe(true)
  })

  it('keeps the default menu in an input', async () => {
    await renderInApp(
      <Host enabled>
        <Input aria-label="Title" />
      </Host>,
    )
    expect(fireEvent.contextMenu(page.getByRole('textbox', { name: 'Title' }))).toBe(true)
  })

  it('keeps the default menu on rendered note text', async () => {
    await renderInApp(
      <Host enabled>
        <BacklinkSnippet
          text="Planning **kickoff** notes"
          notePath="notes/meeting.md"
          tasks={[]}
          onWikilinkClick={noop}
        />
      </Host>,
    )
    const word = page.getByText('kickoff')
    await expect.element(word).toBeVisible()
    expect(fireEvent.contextMenu(word)).toBe(true)
  })

  it('keeps the default menu on a chat message', async () => {
    await renderInApp(
      <Host enabled>
        <ChatTurn
          turn={{
            id: 'turn-1',
            userText: 'What is due today?',
            attachments: [],
            parts: [],
            responseMessages: [],
            status: 'done',
          }}
        />
      </Host>,
    )
    expect(fireEvent.contextMenu(page.getByText('What is due today?'))).toBe(true)
  })

  it('keeps the default menu on a protected note', async () => {
    await renderInApp(
      <Host enabled>
        <ProtectedNoteView content={'Setext heading\n==============\n'} />
      </Host>,
    )
    expect(fireEvent.contextMenu(page.getByText('Setext heading'))).toBe(true)
  })
})
