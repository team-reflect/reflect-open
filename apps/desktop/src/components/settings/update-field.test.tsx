import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@reflect/app'
import { createTestUpdateService, type TestUpdateService } from '@reflect/app/testing'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { UpdateField } from './update-field.tsx'

async function renderField(state: UpdateState): Promise<TestUpdateService> {
  const update = createTestUpdateService(state)
  await renderInApp(<UpdateField />, {
    appServices: { update },
    wrapper: (children) => <UpdateProvider autoCheck={false}>{children}</UpdateProvider>,
  })
  return update
}

describe('UpdateField', () => {
  it('retries the install after an install failure: the found update is still there', async () => {
    const update = await renderField({
      phase: 'error',
      message: 'signature verification failed',
      during: 'install',
    })
    expect(page.getByRole('alert').element().textContent).toMatch(/signature verification failed/)
    await userEvent.click(page.getByRole('button', { name: 'Retry install' }))
    expect(update.calls).toEqual(['retryAction', 'install'])
  })

  it('re-checks after a check failure', async () => {
    const update = await renderField({
      phase: 'error',
      message: 'release endpoint unreachable',
      during: 'check',
    })
    await userEvent.click(page.getByRole('button', { name: 'Check for updates' }))
    expect(update.calls).toEqual(['retryAction', 'checkNow'])
  })
})
