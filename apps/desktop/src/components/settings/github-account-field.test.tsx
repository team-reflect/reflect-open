import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import type { GithubAuthService } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { GithubAccountField } from './github-account-field.tsx'

// The account row belongs to the machine, not to the open graph: it renders
// the same whether or not a graph syncs, and sign-out only touches the
// keychain (every graph's git sync restarts by itself).

async function renderField(options: { signedIn: boolean }): Promise<{
  core: TestCoreServices
  clear: MockInstance<GithubAuthService['clear']>
}> {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  if (options.signedIn) {
    await core.githubAuth.save({ kind: 'pat', token: 'ghp_test' })
  }
  const clear = vi.spyOn(core.githubAuth, 'clear')
  await renderInApp(<GithubAccountField />, { core })
  return { core, clear }
}

describe('GithubAccountField', () => {
  it('offers to sign in when no credential is stored', async () => {
    await renderField({ signedIn: false })

    await expect.element(page.locate('legend').getByText('GitHub')).toBeVisible()
    await expect.element(page.getByText(/Sign in to connect a GitHub repository/)).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /Sign out of GitHub/ }))
      .not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Sign in to GitHub…' }))

    await expect.element(page.getByRole('heading', { name: 'Sign in to GitHub' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
  })

  it('confirms before signing out', async () => {
    const { clear } = await renderField({ signedIn: true })

    await expect
      .element(page.getByText(/Used for GitHub repositories and for sharing/))
      .toBeVisible()
    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()
    await expect
      .element(page.getByText(/Every graph that syncs with a GitHub repository/))
      .toBeVisible()
    expect(clear).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
    await expect
      .element(page.getByRole('heading', { name: 'Sign out of GitHub?' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Sign in to GitHub…' })).toBeVisible()
    // Keyboard focus moves to the button that replaced the sign-out row.
    await expect.element(page.getByRole('button', { name: 'Sign in to GitHub…' })).toHaveFocus()
  })

  it('shows sign-out failures inside the confirmation dialog', async () => {
    const { clear } = await renderField({ signedIn: true })
    clear.mockRejectedValueOnce(new Error('Keychain denied'))

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()
    await expect.element(page.getByRole('dialog').getByText('Keychain denied')).toBeVisible()
    await expectLocatorToHaveCount(page.getByText('Keychain denied'), 1)
  })

  it('does not close the sign-out dialog while sign-out is pending', async () => {
    const { clear } = await renderField({ signedIn: true })
    const pendingSignOut = Promise.withResolvers<void>()
    clear.mockImplementationOnce(() => pendingSignOut.promise)

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))
    await userEvent.keyboard('{Escape}')

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()
    pendingSignOut.resolve()
    await expect
      .element(page.getByRole('heading', { name: 'Sign out of GitHub?' }))
      .not.toBeInTheDocument()
  })
})
