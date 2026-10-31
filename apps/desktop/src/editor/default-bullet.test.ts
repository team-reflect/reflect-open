import { describe, expect, it } from 'vitest'
import { EMPTY_BULLET_SEED, editorBodyWithDefaultBullet } from './default-bullet.ts'

describe('editorBodyWithDefaultBullet', () => {
  it('seeds an empty body with a bullet when the setting is on', () => {
    expect(editorBodyWithDefaultBullet('', true)).toBe(EMPTY_BULLET_SEED)
  })

  it('treats a whitespace-only body as empty', () => {
    // An emptied note round-trips through meowdown as a lone newline; it should
    // still re-open on a bullet, not a blank line.
    expect(editorBodyWithDefaultBullet('\n', true)).toBe(EMPTY_BULLET_SEED)
    expect(editorBodyWithDefaultBullet('   \n', true)).toBe(EMPTY_BULLET_SEED)
  })

  it('leaves an empty body untouched when the setting is off', () => {
    expect(editorBodyWithDefaultBullet('', false)).toBe('')
    expect(editorBodyWithDefaultBullet('\n', false)).toBe('\n')
  })

  it('never seeds a note that already has content', () => {
    expect(editorBodyWithDefaultBullet('- existing\n', true)).toBe('- existing\n')
    // A titled new note (⌘N) keeps its `#` heading body — caret in the title,
    // not a bullet.
    expect(editorBodyWithDefaultBullet('#\n', true)).toBe('#\n')
  })
})
