import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { createTestCoreServices, createTestSettingsService } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useSettings } from './settings-provider.tsx'

describe('useSettings', () => {
  it('renders the settings of the app services and forwards updates', async () => {
    const settings = createTestSettingsService({ editorMarkdownSyntax: 'show' })
    const core = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    const { result } = await renderHookInApp(() => useSettings(), { core })

    await act(async () => {
      await expect(result.current.whenSettingsLoaded()).resolves.toBe('loaded')
    })
    expect(result.current.settings).toBe(settings.get())
    expect(result.current.settings.editorMarkdownSyntax).toBe('show')

    await act(() => {
      result.current.updateSettings({ editorFullWidth: true })
    })
    expect(result.current.settings.editorFullWidth).toBe(true)

    await act(() => {
      result.current.updateSettingsWith((current) => ({
        editorTextSize: current.editorFullWidth ? 'large' : 'small',
      }))
    })
    expect(result.current.settings.editorTextSize).toBe('large')
    await settings.flush()
    expect(settings.saves().at(-1)).toBe(settings.get())
  })

  it('loads once in StrictMode', async () => {
    const settings = createTestSettingsService()
    const core = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    const { result } = await renderHookInApp(() => useSettings(), {
      core,
      wrapper: (children: ReactNode) => <StrictMode>{children}</StrictMode>,
    })
    await act(async () => {
      await result.current.whenSettingsLoaded()
    })
    const loads = settings.ipc.calls().filter(({ command }) => command === 'settings_load')
    expect(loads).toHaveLength(1)
  })
})
