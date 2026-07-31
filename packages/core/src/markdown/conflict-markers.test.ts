import { describe, expect, it } from 'vitest'
import {
  conflictMarkerBlockCount,
  conflictMarkerLabels,
  detectConflictMarkers,
  parseConflictMarkers,
  resolveConflictMarkers,
} from './conflict-markers'

const CONFLICTED = [
  '# Shared',
  '',
  '<<<<<<< this device',
  'edited on a',
  '=======',
  'edited on b',
  '>>>>>>> other device',
  '',
].join('\n')

describe('detectConflictMarkers', () => {
  it('detects a complete labeled marker block', () => {
    expect(detectConflictMarkers(CONFLICTED)).toBe(true)
  })

  it('detects markers with CRLF line endings', () => {
    expect(detectConflictMarkers(CONFLICTED.replaceAll('\n', '\r\n'))).toBe(true)
  })

  it('requires the full sequence in order', () => {
    expect(detectConflictMarkers('plain note body')).toBe(false)
    expect(detectConflictMarkers('<<<<<<< this device\nno separator or end')).toBe(false)
    expect(detectConflictMarkers('=======\n>>>>>>> other device\n<<<<<<< late start')).toBe(false)
  })

  it('ignores prose that merely mentions a marker line', () => {
    const prose = 'Git writes `>>>>>>> theirs` after a `=======` separator.'
    expect(detectConflictMarkers(prose)).toBe(false)
  })

  it('requires a label after the start/end arrows (as git writes them)', () => {
    expect(detectConflictMarkers('<<<<<<<\nx\n=======\ny\n>>>>>>>')).toBe(false)
  })

  it('clears once the user resolves by editing the markers away', () => {
    const resolved = CONFLICTED.split('\n')
      .filter(
        (line) => !line.startsWith('<<<<<<<') && line !== '=======' && !line.startsWith('>>>>>>>'),
      )
      .join('\n')
    expect(detectConflictMarkers(resolved)).toBe(false)
  })
})

describe('resolveConflictMarkers', () => {
  it('keeps this device’s side', () => {
    const resolved = resolveConflictMarkers(CONFLICTED, 'ours')
    expect(resolved).toBe('# Shared\n\nedited on a\n')
    expect(detectConflictMarkers(resolved)).toBe(false)
  })

  it('keeps the other device’s side', () => {
    expect(resolveConflictMarkers(CONFLICTED, 'theirs')).toBe('# Shared\n\nedited on b\n')
  })

  it('keeps both sides in order (the daily-note append case)', () => {
    expect(resolveConflictMarkers(CONFLICTED, 'both')).toBe(
      '# Shared\n\nedited on a\nedited on b\n',
    )
  })

  it('resolves every block and leaves surrounding text byte-identical', () => {
    const twoBlocks = [
      'intro',
      '<<<<<<< this device',
      'a1',
      '=======',
      'b1',
      '>>>>>>> other device',
      'middle  ', // trailing spaces survive
      '<<<<<<< this device',
      'a2',
      '=======',
      'b2',
      '>>>>>>> other device',
      'outro',
    ].join('\n')
    expect(resolveConflictMarkers(twoBlocks, 'theirs')).toBe('intro\nb1\nmiddle  \nb2\noutro')
  })

  it('handles CRLF sources', () => {
    const resolved = resolveConflictMarkers(CONFLICTED.replaceAll('\n', '\r\n'), 'ours')
    expect(resolved).toBe('# Shared\r\n\r\nedited on a\r\n')
  })

  it('tolerates an unterminated block without throwing or dropping text', () => {
    const truncated = 'before\n<<<<<<< this device\nkept line'
    expect(resolveConflictMarkers(truncated, 'ours')).toBe('before\nkept line')
    expect(resolveConflictMarkers(truncated, 'theirs')).toBe('before')
  })

  it('is the identity on unconflicted text', () => {
    expect(resolveConflictMarkers('plain\ntext\n', 'ours')).toBe('plain\ntext\n')
  })
})

describe('conflictMarkerLabels', () => {
  it('parses device-name labels from the first complete block', () => {
    const marked =
      "intro\n<<<<<<< Alex's MacBook Pro\nmac\n=======\nphone\n>>>>>>> Alex's iPhone\noutro\n"
    expect(conflictMarkerLabels(marked)).toEqual({
      ours: "Alex's MacBook Pro",
      theirs: "Alex's iPhone",
    })
  })

  it('parses the git path’s generic labels', () => {
    expect(conflictMarkerLabels(CONFLICTED)).toEqual({
      ours: 'this device',
      theirs: 'other device',
    })
  })

  it('returns null when there is no complete block', () => {
    expect(conflictMarkerLabels('plain\ntext\n')).toBeNull()
    expect(conflictMarkerLabels('<<<<<<< a\nunterminated')).toBeNull()
    // Out-of-order marker lines are prose, not a conflict.
    expect(conflictMarkerLabels('=======\n>>>>>>> b\n<<<<<<< a\n')).toBeNull()
  })
})

describe('parseConflictMarkers', () => {
  it('splits text and conflict blocks in file order, labels included', () => {
    expect(parseConflictMarkers(CONFLICTED)).toEqual([
      { kind: 'text', text: '# Shared\n' },
      {
        kind: 'conflict',
        ours: { label: 'this device', text: 'edited on a' },
        theirs: { label: 'other device', text: 'edited on b' },
      },
      { kind: 'text', text: '' },
    ])
  })

  it('keeps the sides a resolution would keep — same splice, per side', () => {
    const segments = parseConflictMarkers(CONFLICTED)
    const conflict = segments.find((segment) => segment.kind === 'conflict')
    expect(conflict?.kind).toBe('conflict')
    if (conflict?.kind === 'conflict') {
      expect(resolveConflictMarkers(CONFLICTED, 'ours')).toContain(conflict.ours.text)
      expect(resolveConflictMarkers(CONFLICTED, 'theirs')).toContain(conflict.theirs.text)
    }
  })

  it('parses the iCloud sweep’s stacked shape, empty sides included', () => {
    const stacked =
      '<<<<<<< Mac\nmac\n=======\nphone\n>>>>>>> iPhone\n<<<<<<< Mac\n=======\nipad\n>>>>>>> iPad\n'
    expect(parseConflictMarkers(stacked)).toEqual([
      {
        kind: 'conflict',
        ours: { label: 'Mac', text: 'mac' },
        theirs: { label: 'iPhone', text: 'phone' },
      },
      {
        kind: 'conflict',
        ours: { label: 'Mac', text: '' },
        theirs: { label: 'iPad', text: 'ipad' },
      },
      { kind: 'text', text: '' },
    ])
  })

  it('flows an unterminated block back into the text verbatim', () => {
    const truncated = 'before\n<<<<<<< this device\nkept line'
    expect(parseConflictMarkers(truncated)).toEqual([{ kind: 'text', text: truncated }])
  })

  it('is a single text segment on unconflicted text', () => {
    expect(parseConflictMarkers('plain\ntext\n')).toEqual([{ kind: 'text', text: 'plain\ntext\n' }])
  })
})

describe('conflictMarkerBlockCount', () => {
  it('counts complete blocks only', () => {
    expect(conflictMarkerBlockCount('plain\ntext\n')).toBe(0)
    expect(conflictMarkerBlockCount(CONFLICTED)).toBe(1)
    expect(conflictMarkerBlockCount('<<<<<<< a\nunterminated')).toBe(0)
  })

  it('counts the iCloud sweep’s stacked three-way shape as two blocks', () => {
    const stacked =
      '<<<<<<< Mac\nmac\n=======\nphone\n>>>>>>> iPhone\n<<<<<<< Mac\n=======\nipad\n>>>>>>> iPad\n'
    expect(conflictMarkerBlockCount(stacked)).toBe(2)
  })
})
