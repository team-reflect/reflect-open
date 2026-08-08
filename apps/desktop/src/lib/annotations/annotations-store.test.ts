import { describe, expect, it } from 'vitest'
import { parseAnnotationFile } from './annotations-store'

describe('parseAnnotationFile', () => {
  it('parses a valid sidecar', () => {
    const json = JSON.stringify({
      version: 1,
      path: 'assets/paper.pdf',
      annotations: [
        {
          id: 'a1',
          pageIndex: 0,
          type: 'text',
          rects: [[0.1, 0.2, 0.3, 0.4]],
          color: '#ff0000',
          text: 'note',
        },
      ],
    })
    expect(parseAnnotationFile(json)).toEqual({
      version: 1,
      path: 'assets/paper.pdf',
      annotations: [
        {
          id: 'a1',
          pageIndex: 0,
          type: 'text',
          rects: [[0.1, 0.2, 0.3, 0.4]],
          color: '#ff0000',
          text: 'note',
        },
      ],
    })
  })

  it('tolerates an empty sidecar (the read\'s "nothing cached yet" answer)', () => {
    expect(parseAnnotationFile('')).toBeNull()
    expect(parseAnnotationFile('   ')).toBeNull()
  })

  it('tolerates malformed JSON', () => {
    expect(parseAnnotationFile('{not json')).toBeNull()
    expect(parseAnnotationFile('{"version":')).toBeNull()
  })

  it('rejects JSON that is not the sidecar shape', () => {
    expect(parseAnnotationFile('[]')).toBeNull()
    expect(parseAnnotationFile('"assets/paper.pdf"')).toBeNull()
    expect(parseAnnotationFile('null')).toBeNull()
  })

  it('rejects an unsupported version and a malformed annotation', () => {
    expect(
      parseAnnotationFile('{"version": 2, "path": "assets/paper.pdf", "annotations": []}'),
    ).toBeNull()
    expect(
      parseAnnotationFile(
        JSON.stringify({
          version: 1,
          path: 'assets/paper.pdf',
          annotations: [
            { id: 'a1', pageIndex: -1, type: 'text', rects: [], color: '#000', text: '' },
          ],
        }),
      ),
    ).toBeNull()
  })
})
