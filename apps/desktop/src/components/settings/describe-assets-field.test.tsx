import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  cleanup()
})

describe('DescribeAssetsField', () => {
  it('reflects and toggles the automatic OCR setting', () => {
    render(<DescribeAssetsField />)
    const toggle = screen.getByRole('switch', { name: /ocr new assets automatically/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ describeAssets: false })
  })

  it('disables the backfill until an AI provider is configured', () => {
    settingsRef.current = { ...settingsRef.current, aiProviders: [], defaultAiProviderId: null }
    render(<DescribeAssetsField />)
    expect(screen.getByRole('button', { name: /backfill assets/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/add an ai provider to enable this/i)).not.toBeNull()
  })

  it('confirms the cost before running the backfill, then runs it pinned to the graph', () => {
    render(<DescribeAssetsField />)
    fireEvent.click(screen.getByRole('button', { name: /backfill assets/i }))

    // The cost warning appears; nothing is sent until the user confirms.
    expect(screen.queryByText(/backfill assets\?/i)).not.toBeNull()
    expect(backfill).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^backfill assets$/i }))
    expect(backfill).toHaveBeenCalledWith(5, {
      providers: [PROVIDER],
      defaultProviderId: 'cfg',
    })
  })

  it('cancels without sending anything', () => {
    render(<DescribeAssetsField />)
    fireEvent.click(screen.getByRole('button', { name: /backfill assets/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(backfill).not.toHaveBeenCalled()
  })
})
