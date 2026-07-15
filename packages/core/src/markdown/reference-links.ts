import type { SyntaxNode, Tree } from '@lezer/common'
import { decodeString } from 'micromark-util-decode-string'
import { normalizeIdentifier } from 'micromark-util-normalize-identifier'
import type { MarkdownLinkReference, Span } from './model'

/** One first-definition-wins CommonMark link definition. */
export interface ReferenceDefinition {
  readonly key: string
  readonly href: string
  /** Destination source coordinates in the frontmatter-free body. */
  readonly destination: Span
  /** True when a later definition repeats the normalized label. */
  readonly duplicate: boolean
}

/** Definitions resolved document-wide by normalized label. */
export type ReferenceDefinitions = ReadonlyMap<string, ReferenceDefinition>

/** A reference-link occurrence paired with its document-wide definition. */
export interface ResolvedReferenceLink extends MarkdownLinkReference {
  readonly href: string
  readonly text: string
  readonly destination: Span
}

/** Normalize a CommonMark reference label for case-insensitive matching. */
export function normalizeReferenceLabel(label: string): string {
  return normalizeIdentifier(label)
}

function definitionFromNode(body: string, node: SyntaxNode): ReferenceDefinition | null {
  const labelNode = node.getChild('LinkLabel')
  const urlNode = node.getChild('URL')
  if (labelNode === null || urlNode === null) {
    return null
  }
  const key = normalizeReferenceLabel(body.slice(labelNode.from + 1, labelNode.to - 1))
  if (key === '') {
    return null
  }
  const rawHref = body.slice(urlNode.from, urlNode.to)
  const bracketed = rawHref.startsWith('<') && rawHref.endsWith('>')
  const destination = {
    from: urlNode.from + (bracketed ? 1 : 0),
    to: urlNode.to - (bracketed ? 1 : 0),
  }
  return {
    key,
    href: decodeString(body.slice(destination.from, destination.to)),
    destination,
    duplicate: false,
  }
}

/** Collect valid definitions in document order, retaining the first duplicate. */
export function collectReferenceDefinitions(body: string, tree: Tree): ReferenceDefinitions {
  const definitions = new Map<string, ReferenceDefinition>()
  const duplicateKeys = new Set<string>()
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') {
        return true
      }
      const definition = definitionFromNode(body, node.node)
      if (definition === null) {
        return false
      }
      if (definitions.has(definition.key)) {
        duplicateKeys.add(definition.key)
      } else {
        definitions.set(definition.key, definition)
      }
      return false
    },
  })
  for (const key of duplicateKeys) {
    const definition = definitions.get(key)
    if (definition !== undefined) {
      definitions.set(key, { ...definition, duplicate: true })
    }
  }
  return definitions
}

/** Resolve a full, collapsed, or shortcut reference link node. */
export function resolveReferenceLink(
  body: string,
  node: SyntaxNode,
  definitions: ReferenceDefinitions,
): ResolvedReferenceLink | null {
  const marks = node.getChildren('LinkMark')
  if (marks.length !== 2) {
    return null
  }
  const text = body.slice(marks[0]!.to, marks[1]!.from)
  const labelNode = node.getChild('LinkLabel')
  const authoredLabel =
    labelNode === null ? text : body.slice(labelNode.from + 1, labelNode.to - 1) || text
  const key = normalizeReferenceLabel(authoredLabel)
  const definition = definitions.get(key)
  return definition === undefined
    ? null
    : {
        href: definition.href,
        text,
        destination: definition.destination,
        key,
        duplicate: definition.duplicate,
      }
}
