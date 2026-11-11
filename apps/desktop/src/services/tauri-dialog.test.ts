import { describe, expect, it } from 'vitest'
import { pickedPath } from './tauri-dialog.ts'

describe('pickedPath', () => {
  it('passes a desktop path through untouched', () => {
    expect(pickedPath('/Users/me/Downloads/report.pdf')).toBe('/Users/me/Downloads/report.pdf')
    expect(pickedPath(String.raw`C:\Users\me\report.pdf`)).toBe(String.raw`C:\Users\me\report.pdf`)
  })

  it('turns an iOS document-picker URL into its sandbox path', () => {
    expect(
      pickedPath(
        'file:///private/var/mobile/Containers/Data/Application/ABC/tmp/app.reflect.ios-Inbox/My%20Photo%20%231.jpg',
      ),
    ).toBe(
      '/private/var/mobile/Containers/Data/Application/ABC/tmp/app.reflect.ios-Inbox/My Photo #1.jpg',
    )
  })
})
