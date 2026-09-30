import { parseMarkdownAst, walkMarkdownAst } from '@meowdown/markdown'
import { getTaskParagraph } from '../markdown/task-projection.ts'
import { parseBody } from '../markdown/grammar.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { TaskAddress } from '../markdown/task-path.ts'

/** A rendered checkbox and, when available, its address in the source note. */
export interface SnippetTask {
  checked: boolean
  round: boolean
  text: string
  address?: TaskAddress
}
export interface SnippetTaskSource {
  content: string
  notePath: string
  /** Whole-file offsets of the dedented snippet line starts. */
  lineOrigins: readonly number[]
}

/** Enumerate snippet checkboxes and map their source positions to AST addresses. */
export function extractSnippetTasks(snippet: string, source?: SnippetTaskSource): SnippetTask[] {
  const addresses = new Map<number, TaskAddress & { text: string }>()
  if (source) {
    const { body, bodyOffset } = splitFrontmatter(source.content)
    // Both traversals recognize checkboxes only on bullet list items, and in
    // the same document order, so the n-th `Task` node the block parser finds
    // is the n-th `kind: 'task'` item of the AST. This pairing by index is
    // what lets a snippet checkbox resolve to an AST address.
    const entries = [...walkMarkdownAst(parseMarkdownAst(body))].filter(
      ({ node }) => node.type === 'listItem' && node.kind === 'task',
    )
    let index = 0
    parseBody(body).iterate({
      enter: ({ name, from, node }) => {
        if (name !== 'Task' || node.parent?.parent?.name !== 'BulletList') return
        const entry = entries[index++]
        if (entry)
          addresses.set(from + bodyOffset, {
            notePath: source.notePath,
            astPath: entry.path,
            text: getTaskParagraph(entry.node)?.value ?? '',
          })
      },
    })
  }
  const tasks: SnippetTask[] = []
  parseBody(snippet).iterate({
    enter: ({ name, from, node }) => {
      if (name !== 'Task' || node.parent?.parent?.name !== 'BulletList') return
      const lineStart = snippet.lastIndexOf('\n', from - 1) + 1
      const end = snippet.indexOf('\n', from)
      const line = snippet.slice(from, end === -1 ? snippet.length : end)
      const lineIndex = snippet.slice(0, lineStart).split('\n').length - 1
      const origin = source?.lineOrigins[lineIndex]
      const address = origin === undefined ? undefined : addresses.get(origin + from - lineStart)
      tasks.push({
        checked: /^\[x\]/i.test(line),
        round: /^[\t ]*\+[\t ]+$/.test(snippet.slice(lineStart, from)),
        // The whole paragraph when the source is known, so an edit can locate it.
        text: address?.text ?? line.slice(line[3] === ' ' ? 4 : 3),
        ...(address ? { address: { notePath: address.notePath, astPath: address.astPath } } : {}),
      })
    },
  })
  return tasks
}
