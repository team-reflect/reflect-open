import type {
  ContextMenuAction,
  ContextMenuItem,
  ContextMenuOptions,
  ContextMenuService,
} from '../commands/context-menu-service.ts'

/**
 * A {@link ContextMenuService} that records the menus it opens and picks their actions.
 */
export interface TestContextMenuService extends ContextMenuService {
  /**
   * The items of every context menu opened, in order.
   */
  popups(): readonly (readonly ContextMenuItem[])[]
  /**
   * Picks the enabled action `id` in the latest popup, and throws when there is none.
   */
  select(id: string): void
}

function findAction(items: readonly ContextMenuItem[], id: string): ContextMenuAction | undefined {
  for (const item of items) {
    if (item.type === 'action' && item.id === id) {
      return item
    }
    if (item.type === 'submenu') {
      const found = findAction(item.items, id)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

class TestContextMenuServiceImpl implements TestContextMenuService {
  readonly #popups: { items: readonly ContextMenuItem[]; onSelect: (id: string) => void }[] = []

  async open({ items, onSelect }: ContextMenuOptions): Promise<void> {
    this.#popups.push({ items: await items, onSelect })
  }

  popups(): readonly (readonly ContextMenuItem[])[] {
    return this.#popups.map((options) => options.items)
  }

  select(id: string): void {
    const latest = this.#popups.at(-1)
    const item = latest ? findAction(latest.items, id) : undefined
    if (!latest || !item || (item.disabled ?? false)) {
      throw new Error(`no enabled context menu action: ${id}`)
    }
    latest.onSelect(id)
  }
}

export function createTestContextMenuService(): TestContextMenuService {
  return new TestContextMenuServiceImpl()
}
