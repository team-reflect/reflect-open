import { expect, test } from 'vitest'
import { STABLE_UPDATER_ENDPOINT } from './release-macos.mjs'
import { createWindowsBuildArgs, findSetupExe, resolveWindowsFlavor } from './release-windows.mjs'

test('prerelease versions build the beta flavor', () => {
  expect(resolveWindowsFlavor('0.11.0-beta')).toBe('beta')
  expect(resolveWindowsFlavor('0.11.0-beta.2')).toBe('beta')
  expect(resolveWindowsFlavor('0.11.0')).toBe('stable')
})

test('the build produces only the x64 NSIS bundle', () => {
  for (const flavor of ['stable', 'beta']) {
    const args = createWindowsBuildArgs({ flavor })
    expect(args).toContain('x86_64-pc-windows-msvc')
    expect(args).toContain('nsis')
    expect(args).not.toContain('msi')
  }
})

test('the beta flavor builds with the beta overlay', () => {
  expect(createWindowsBuildArgs({ flavor: 'beta' })).toContain('src-tauri/tauri.beta.conf.json')
})

test('stable builds pin the stable updater endpoint', () => {
  const inline = createWindowsBuildArgs({ flavor: 'stable' }).filter((arg) => arg.startsWith('{'))
  expect(inline).toHaveLength(1)
  expect(JSON.parse(inline[0])).toEqual({
    plugins: { updater: { endpoints: [STABLE_UPDATER_ENDPOINT] } },
  })
})

test('findSetupExe requires exactly one installer', () => {
  expect(findSetupExe(['Reflect Beta_0.11.0-beta_x64-setup.exe', 'other.txt'])).toBe(
    'Reflect Beta_0.11.0-beta_x64-setup.exe',
  )
  expect(() => findSetupExe([])).toThrow('found 0')
  expect(() => findSetupExe(['a-setup.exe', 'b-setup.exe'])).toThrow('found 2')
})
