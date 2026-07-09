import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { docToMarkdown, markdownToDoc } from '@meowdown/core'
import { DOMParser, Fragment, Slice, type Schema } from '@prosekit/pm/model'
import { BlockDragClipboard } from './block-drag-clipboard'

interface DraggingStub {
  readonly slice: Slice
  readonly move: boolean
  readonly node: object
}

const editor = vi.hoisted(() => ({
  mounted: true,
  view: {
    dom: document.createElement('div'),
    dragging: null as DraggingStub | null,
    serializeForClipboard: vi.fn(),
    state: { schema: null as Schema | null },
  },
}))

vi.mock('@meowdown/react', () => ({
  useEditor: () => editor,
}))

function renderBridge(): void {
  render(
    <div className="meowdown">
      <div
        ref={(element) => {
          if (element !== null) {
            editor.view.dom = element
          }
        }}
      />
      {createElement('prosekit-block-handle-draggable', {
        'data-testid': 'block-handle',
      })}
      <div draggable data-testid="other-drag-source" />
      <BlockDragClipboard />
    </div>,
  )
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>()
  return {
    clearData: vi.fn((type?: string) => {
      if (type === undefined) {
        values.clear()
      } else {
        values.delete(type)
      }
    }),
    getData: vi.fn((type: string) => values.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
  } as unknown as DataTransfer
}

afterEach(() => {
  cleanup()
  editor.mounted = true
  editor.view.dom = document.createElement('div')
  editor.view.dragging = null
  editor.view.state.schema = null
  vi.clearAllMocks()
})

describe('BlockDragClipboard', () => {
  it('serializes a handled round task as lossless ProseMirror clipboard data', () => {
    const sourceDocument = markdownToDoc('+ [ ] Task')
    const sourceTask = sourceDocument.firstChild
    expect(sourceTask).not.toBeNull()
    const sourceSlice = new Slice(Fragment.from(sourceTask), 0, 0)
    const serializedSlice = new Slice(sourceSlice.content, 0, 0)
    const selectedNode = { from: 3, to: 29 }
    const container = document.createElement('div')
    container.innerHTML =
      '<ul data-pm-slice="0 0 []"><li data-list-kind="task"><p>Task</p></li></ul>'
    editor.view.state.schema = sourceDocument.type.schema
    editor.view.dragging = { slice: sourceSlice, move: true, node: selectedNode }
    editor.view.serializeForClipboard.mockReturnValue({
      dom: container,
      text: '+ [ ] Task',
      slice: serializedSlice,
    })
    const transfer = dataTransfer()

    renderBridge()
    fireEvent.dragStart(screen.getByTestId('block-handle'), { dataTransfer: transfer })

    expect(editor.view.serializeForClipboard).toHaveBeenCalledWith(sourceSlice)
    const html = transfer.getData('text/html')
    const transferred = document.createElement('div')
    transferred.innerHTML = html
    expect(transferred.firstElementChild).toHaveAttribute('data-pm-slice', '0 0 []')
    expect(transferred.firstElementChild).toHaveAttribute('data-list-kind', 'task')
    expect(transferred.firstElementChild).toHaveAttribute('data-list-marker', '+')
    expect(docToMarkdown(DOMParser.fromSchema(sourceDocument.type.schema).parse(transferred))).toBe(
      '+ [ ] Task\n',
    )
    expect(transfer.getData('text/plain')).toBe('+ [ ] Task')
    expect(editor.view.dragging).toEqual({
      slice: serializedSlice,
      move: true,
      node: selectedNode,
    })
  })

  it('does not rewrite unrelated drag payloads', () => {
    editor.view.dragging = {
      slice: Slice.empty,
      move: true,
      node: { from: 1, to: 2 },
    }

    renderBridge()
    fireEvent.dragStart(screen.getByTestId('other-drag-source'), {
      dataTransfer: dataTransfer(),
    })

    expect(editor.view.serializeForClipboard).not.toHaveBeenCalled()
  })

  it('clears the source slice when the handled drag ends', () => {
    editor.view.dragging = {
      slice: Slice.empty,
      move: true,
      node: { from: 1, to: 2 },
    }

    renderBridge()
    fireEvent.dragEnd(screen.getByTestId('block-handle'))

    expect(editor.view.dragging).toBeNull()
  })
})
