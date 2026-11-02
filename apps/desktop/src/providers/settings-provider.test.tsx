import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { createTestCoreServices, createTestSettingsService } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useEditorFullWidth, useSettingsStore } from './settings-provider.tsx'

describe('useSettingsStore', () => {
  it('renders the settings of the app services and follows updates', async () => {
    const settings = createTestSettingsService({ editorMarkdownSyntax: 'show' })
    const core = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    const { result } = await renderHookInApp(() => useSettingsStore(), { core })

    await act(async () => {
      await expect(settings.whenLoaded()).resolves.toBe('loaded')
    })
    expect(result.current).toBe(settings.get())
    expect(result.current.editorMarkdownSyntax).toBe('show')

    await act(() => {
      settings.update({ editorFullWidth: true })
    })
    expect(result.current.editorFullWidth).toBe(true)

    await act(() => {
      settings.updateWith((current) => ({
        editorTextSize: current.editorFullWidth ? 'large' : 'small',
      }))
    })
    expect(result.current.editorTextSize).toBe('large')
    await settings.flush()
    expect(settings.saves().at(-1)).toBe(settings.get())
  })

  it('loads once in StrictMode', async () => {
    const settings = createTestSettingsService()
    const core = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    await renderHookInApp(() => useSettingsStore(), {
      core,
      wrapper: (children: ReactNode) => <StrictMode>{children}</StrictMode>,
    })
    await act(async () => {
      await settings.whenLoaded()
    })
    const loads = settings.ipc.calls().filter(({ command }) => command === 'settings_load')
    expect(loads).toHaveLength(1)
  })
})

describe('useEditorFullWidth', () => {
  it('re-renders only when its field changes', async () => {
    const settings = createTestSettingsService()
    const core = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    let renders = 0
    const { result } = await renderHookInApp(
      () => {
        renders += 1
        return useEditorFullWidth()
      },
      { core },
    )
    await act(async () => {
      await settings.whenLoaded()
    })
    const rendersBefore = renders

    await act(() => {
      settings.update({ editorTextSize: 'large' })
    })
    expect(renders).toBe(rendersBefore)

    await act(() => {
      settings.update({ editorFullWidth: true })
    })
    expect(result.current).toBe(true)
    expect(renders).toBeGreaterThan(rendersBefore)
  })
})
