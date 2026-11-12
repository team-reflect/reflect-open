import { createContext } from 'react'

/**
 * The element the editor's menus and popovers stay inside. Unset, they stay
 * inside the viewport.
 */
export const MenuBoundaryContext = createContext<Element | undefined>(undefined)
