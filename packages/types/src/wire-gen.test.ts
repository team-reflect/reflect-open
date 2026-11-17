import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = path.join(import.meta.dirname, '../../..')
const wirePath = 'packages/types/src/wire-gen.ts'

/**
 * Hand-written types that share a name or the fields of a wire type, and are
 * a different type.
 */
const DIFFERENT_TYPES = new Set([
  // The UI group of one source note, not the row of a backlink page.
  'apps/web/src/lib/group-backlinks.ts:BacklinkSource',
  // Holds the menu of the page, with `ChromeMenuItem` rows.
  'apps/web/src/mobile/sidebar.ts:SidebarState',
  // The decoded task, not the stored row.
  'packages/core/src/markdown/task-ast.ts:TaskRow',
])

interface ObjectType {
  readonly name: string
  /**
   * The sorted property names, joined with commas.
   */
  readonly fields: string
}

/**
 * Every exported interface and object type alias at the top level of a file.
 */
function listObjectTypes(file: string): ObjectType[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), {
    languageVersion: ts.ScriptTarget.Latest,
  })
  const types: ObjectType[] = []
  for (const statement of source.statements) {
    let members: ts.NodeArray<ts.TypeElement>
    if (ts.isInterfaceDeclaration(statement)) {
      members = statement.members
    } else if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
      members = statement.type.members
    } else {
      continue
    }
    const exported = statement.modifiers?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.ExportKeyword
    })
    if (exported !== true) {
      continue
    }
    const fields = members.map((member) => member.name?.getText(source) ?? '')
    types.push({ name: statement.name.text, fields: fields.toSorted().join(',') })
  }
  return types
}

it('has no hand-written copy of a wire type', () => {
  const wireTypes = listObjectTypes(wirePath)
  const wireNames = new Set(wireTypes.map((type) => type.name))
  // A type with fewer than 3 fields matches by chance.
  const wireFields = new Map(
    wireTypes
      .filter((type) => type.fields.split(',').length >= 3)
      .map((type) => [type.fields, type.name]),
  )
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file !== '' && file !== wirePath)

  const copies: string[] = []
  for (const file of files) {
    for (const type of listObjectTypes(file)) {
      const wireName = wireNames.has(type.name) ? type.name : wireFields.get(type.fields)
      if (wireName !== undefined && !DIFFERENT_TYPES.has(`${file}:${type.name}`)) {
        copies.push(`${file}: re-export ${wireName} from @reflect/types in place of ${type.name}`)
      }
    }
  }

  expect(copies).toEqual([])
})
