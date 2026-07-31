import { describe, expect, it } from 'vitest'
import { pickFiles } from './pick-files'

function openedInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) {
    throw new Error('pickFiles did not attach an input to the body')
  }
  return input
}

describe('pickFiles', () => {
  it('resolves with the chosen files and detaches its input', async () => {
    const pending = pickFiles({ accept: 'image/*', multiple: true })
    const input = openedInput()
    expect(input.accept).toBe('image/*')
    expect(input.multiple).toBe(true)

    const transfer = new DataTransfer()
    transfer.items.add(new File(['png'], 'photo.png', { type: 'image/png' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change'))

    const files = await pending
    expect(files.map((file) => file.name)).toEqual(['photo.png'])
    expect(document.body.querySelector('input[type="file"]')).toBeNull()
  })

  it('resolves empty when the picker is dismissed', async () => {
    const pending = pickFiles()
    const input = openedInput()
    expect(input.multiple).toBe(false)

    input.dispatchEvent(new Event('cancel'))

    await expect(pending).resolves.toEqual([])
    expect(document.body.querySelector('input[type="file"]')).toBeNull()
  })
})
