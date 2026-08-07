import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AiPrompt } from '@reflect/core'
import '@/test-utils/locator'

/**
 * The mobile add/edit sheet for a saved AI prompt: collecting a draft for
 * `onSave` (trimmed, with the chosen result mode), prefilling from the
 * edited prompt, gating save on the required fields, and removing only from
 * the edit sheet.
 */

// Keep the sheet content inline so this suite exercises its state flow
// without depending on the drawer's drag and animation behavior.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { AiPromptDrawer } = await import('./ai-prompt-drawer')

const onSave = vi.fn<(draft: unknown) => void>()
const onRemove = vi.fn<(id: string) => void>()
const onOpenChange = vi.fn<(open: boolean) => void>()

const SAVED_PROMPT: AiPrompt = {
  id: 'prompt-1',
  label: 'Translate to French',
  body: 'Translate the following text to French.\n\n{{selectedText}}',
  mode: 'replace',
}

beforeEach(() => {
  onSave.mockReset()
  onRemove.mockReset()
  onOpenChange.mockReset()
})

afterEach(async () => {
  await cleanup()
})

async function renderSheet(prompt: AiPrompt | 'new'): Promise<void> {
  await render(
    <AiPromptDrawer
      prompt={prompt}
      open
      onOpenChange={onOpenChange}
      onSave={onSave}
      onRemove={onRemove}
    />,
  )
}

describe('AiPromptDrawer', () => {
  it('collects a draft and hands it to onSave', async () => {
    const user = userEvent
    await renderSheet('new')

    // `fill`, not `type`: userEvent's type treats `{{` as an escaped brace.
    await user.fill(page.getByLabelText('Label'), '  Shorten  ')
    await user.fill(page.getByLabelText('Prompt'), 'Shorten this: {{selectedText}} ')
    // Options render in a portal, so query them from the page.
    await user.click(page.getByRole('combobox', { name: 'Result' }))
    await user.click(page.getByRole('option', { name: 'Inserted below the selection' }))
    await user.click(page.getByRole('button', { name: 'Add prompt' }))

    expect(onSave).toHaveBeenCalledWith({
      label: 'Shorten',
      body: 'Shorten this: {{selectedText}}',
      mode: 'append',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('disables save until the label and body are filled', async () => {
    const user = userEvent
    await renderSheet('new')

    const save = page.getByRole('button', { name: 'Add prompt' })
    await expect.element(save).toBeDisabled()

    await user.type(page.getByLabelText('Label'), 'Shorten')
    await expect.element(save).toBeDisabled()

    await user.type(page.getByLabelText('Prompt'), 'Shorten this.')
    await expect.element(save).toBeEnabled()
  })

  it('prefills from the edited prompt and saves the changes', async () => {
    const user = userEvent
    await renderSheet(SAVED_PROMPT)

    await expect.element(page.getByLabelText('Label')).toHaveValue(SAVED_PROMPT.label)
    await expect.element(page.getByLabelText('Prompt')).toHaveValue(SAVED_PROMPT.body)

    await user.fill(page.getByLabelText('Label'), 'Translate to German')
    await user.click(page.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledWith({
      label: 'Translate to German',
      body: SAVED_PROMPT.body,
      mode: 'replace',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('removes the edited prompt', async () => {
    const user = userEvent
    await renderSheet(SAVED_PROMPT)

    await user.click(page.getByRole('button', { name: 'Remove' }))

    expect(onRemove).toHaveBeenCalledWith(SAVED_PROMPT.id)
    expect(onSave).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers no Remove on the add sheet', async () => {
    await renderSheet('new')

    await expect.element(page.getByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })
})
