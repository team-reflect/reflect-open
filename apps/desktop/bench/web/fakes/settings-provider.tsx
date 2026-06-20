import type { ReactElement, ReactNode } from 'react'

const SETTINGS = {
  dateFormat: 'mdy',
  weekStartDay: 'monday',
  semanticSearchEnabled: false,
  editorMarkdownSyntax: 'always',
  editorSpellCheck: true,
  editorDefaultBullet: false,
  editorBulletAfterHeading: false,
} as const

/** Static settings — no IPC-backed settings query. Browser-harness only. */
export function useSettings(): { settings: typeof SETTINGS; updateSettings: () => void } {
  return { settings: SETTINGS, updateSettings: () => {} }
}

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>
}
