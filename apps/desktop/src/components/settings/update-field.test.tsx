import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@/lib/update-controller'
import { UpdateField } from './update-field'

const update = vi.hoisted(() => ({
  state: { phase: 'idle' } as UpdateState,
  supported: true,
  checkNow: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
}))
vi.mock('@/providers/update-provider', () => ({ useUpdate: () => update }))

afterEach(() => {
  update.checkNow.mockClear()
  update.install.mockClear()
})

describe('UpdateField', () => {
  it('retries the install after an install failure — the found update is still there', async () => {
    update.state = { phase: 'error', message: 'signature verification failed', during: 'install' }
    await render(<UpdateField />)
    expect(page.getByRole('alert').element().textContent).toMatch(/signature verification failed/)
    await userEvent.click(page.getByRole('button', { name: 'Retry install' }))
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(update.checkNow).not.toHaveBeenCalled()
  })

  it('re-checks after a check failure', async () => {
    update.state = { phase: 'error', message: 'release endpoint unreachable', during: 'check' }
    await render(<UpdateField />)
    await userEvent.click(page.getByRole('button', { name: 'Check for updates' }))
    expect(update.checkNow).toHaveBeenCalledTimes(1)
    expect(update.install).not.toHaveBeenCalled()
  })
})
