import { describe, expect, it, vi } from 'vitest'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openUrlSync } from './open-url'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))

describe('openUrlSync', () => {
  it('forwards the url to the opener', () => {
    openUrlSync('https://example.com')
    expect(openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('logs instead of throwing when the opener rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('no handler'))
    expect(() => openUrlSync('https://example.com')).not.toThrow()
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'failed to open https://example.com:',
        'no handler',
      )
    })
    consoleError.mockRestore()
  })
})
