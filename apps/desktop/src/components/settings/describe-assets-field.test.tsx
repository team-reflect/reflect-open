import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@reflect/core'
import { DescribeAssetsField } from './describe-assets-field'

const settingsRef = vi.hoisted(() => ({ current: {} as Settings }))
const updateSettings = vi.hoisted(() => vi.fn())
const graphRef = vi.hoisted(() => ({ current: { generation: 5 } as { generation: number } | null }))
const backfill = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settingsRef.current, updateSettings }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: graphRef.current }),
}))
vi.mock('@/lib/asset-backfill', () => ({
  backfillAssetDescriptionsVisibly: backfill,
}))

const PROVIDER = { id: 'cfg', provider: 'anthropic' as const, model: 'claude-opus-4-8', keyHint: 'wxyz1' }

beforeEach(() => {
  vi.clearAllMocks()
  graphRef.current = { generation: 5 }
  settingsRef.current = {
    ...DEFAULT_SETTINGS,
    describeAssets: true,
    aiProviders: [PROVIDER],
    defaultAiProviderId: 'cfg',
  }
})

describe('DescribeAssetsField', () => {
  it('reflects and toggles the automatic OCR setting', async () => {
    await render(<DescribeAssetsField />)
    const toggle = page.getByRole('switch', { name: /ocr new assets automatically/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    expect(updateSettings).toHaveBeenCalledWith({ describeAssets: false })
  })

  it('disables the backfill until an AI provider is configured', async () => {
    settingsRef.current = { ...settingsRef.current, aiProviders: [], defaultAiProviderId: null }
    await render(<DescribeAssetsField />)
    await expect
      .element(page.getByRole('button', { name: /backfill assets/i }))
      .toBeDisabled()
    await expect
      .element(page.getByText(/add an ai provider to enable this/i))
      .toBeInTheDocument()
  })

  it('confirms the cost before running the backfill, then runs it pinned to the graph', async () => {
    await render(<DescribeAssetsField />)
    await page.getByRole('button', { name: /backfill assets/i }).click()

    // The cost warning appears; nothing is sent until the user confirms.
    await expect.element(page.getByText(/backfill assets\?/i)).toBeInTheDocument()
    expect(backfill).not.toHaveBeenCalled()

    await page.getByRole('button', { name: /^backfill assets$/i }).click()
    expect(backfill).toHaveBeenCalledWith(5, {
      providers: [PROVIDER],
      defaultProviderId: 'cfg',
    })
  })

  it('cancels without sending anything', async () => {
    await render(<DescribeAssetsField />)
    await page.getByRole('button', { name: /backfill assets/i }).click()
    await page.getByRole('button', { name: /cancel/i }).click()
    expect(backfill).not.toHaveBeenCalled()
  })
})
