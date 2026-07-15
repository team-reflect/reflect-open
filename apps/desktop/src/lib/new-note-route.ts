import { untitledNotePath } from '@reflect/core'
import type { Route } from '@/routing/route'
import {
  grantNewNoteCreation,
  type NewNoteCreationScope,
} from './new-note-creation-claims'

/**
 * Mint the only ordinary-note route that may lazily claim an absent path.
 */
export function newNoteRoute(scope: NewNoteCreationScope): Route {
  const path = untitledNotePath()
  grantNewNoteCreation(scope, path)
  return { kind: 'note', path }
}
