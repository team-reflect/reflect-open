import type { AppPlatform } from '@reflect/core'

export function parseEnvPlatform(): AppPlatform {
  const env = import.meta.env.TAURI_ENV_PLATFORM || ''
  switch (env) {
    case 'ios':
      return 'ios'
    case 'android':
      return 'android'
    case 'windows':
    case 'linux':
    case 'darwin':
    case '':
      return 'desktop'
    default:
      console.warn('[reflect-open] Unknown environment variable TAURI_ENV_PLATFORM:', env)
      return 'desktop'
  }
}
