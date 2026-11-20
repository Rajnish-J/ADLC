// One sidebar view made of collapsible sections, each backed by an existing tree provider (or by nested
// sections). This is how the extension keeps three views — Stories, Agents, Workflows — instead of eight:
// every former view becomes a section, and its provider (discovery watcher, Foundry walk, run service, audit
// store…) keeps working unchanged.
//
// Routing: every element a section's provider returns is remembered against that section, so getTreeItem /
// getChildren for it go back to the provider that made it. A provider's "refresh everything" event refreshes
// only its own section.

import * as vscode from 'vscode'

/** Any tree provider — sections hold providers of different element types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProvider = vscode.TreeDataProvider<any>

export interface SectionSpec {
  id: string
  label: string
  icon: string
  /** The provider whose roots become this section's children. Omit when the section only nests `sections`. */
  provider?: AnyProvider
  /** Sub-sections, shown before the provider's roots. */
  sections?: SectionSpec[]
  /** Start collapsed (default: expanded). */
  collapsed?: boolean
  /** Short status next to the section label, e.g. "3 agents" or "live". */
  describe?: () => string | undefined
  /** Shown as the only row when the section has nothing to show. */
  empty?: { label: string; command?: vscode.Command; icon?: string }
  /** Hide the whole section (e.g. platform sections while disconnected). Re-evaluated on refresh. */
  visible?: () => boolean
  /** contextValue for the section row, so view/item menus can target it (`viewItem == section.<id>`). */
  contextValue?: string
}

export class SectionNode {
  constructor(readonly spec: SectionSpec) {}
}

/** A placeholder row the composite itself owns (empty sections). */
class PlaceholderNode {
  constructor(
    readonly label: string,
    readonly icon: string,
    readonly command?: vscode.Command,
  ) {}
}

type Element = SectionNode | PlaceholderNode | object

export class SectionedTreeProvider implements vscode.TreeDataProvider<Element>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Element | Element[] | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private readonly roots: SectionNode[]
  /** Each section's nested sub-sections. */
  private readonly children = new Map<SectionNode, SectionNode[]>()
  /** Which section's provider produced an element. */
  private readonly owner = new WeakMap<object, SectionNode>()
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(sections: SectionSpec[]) {
    const build = (spec: SectionSpec): SectionNode => {
      const node = new SectionNode(spec)
      this.children.set(node, (spec.sections ?? []).map(build))
      const changed = spec.provider?.onDidChangeTreeData
      if (changed) {
        this.subscriptions.push(
          changed((e: unknown) => {
            // "Everything changed" from a section's provider → refresh just that section.
            this._onDidChangeTreeData.fire(e === undefined || e === null ? node : (e as Element | Element[]))
          }),
        )
      }
      return node
    }
    this.roots = sections.map(build)
  }

  /** The section row with this id (for reveal / refresh). */
  section(sectionId: string): SectionNode | undefined {
    const find = (nodes: SectionNode[]): SectionNode | undefined => {
      for (const n of nodes) {
        if (n.spec.id === sectionId) return n
        const nested = find(this.children.get(n) ?? [])
        if (nested) return nested
      }
      return undefined
    }
    return find(this.roots)
  }

  /** Refresh one section by id, or every section. */
  refresh(sectionId?: string): void {
    if (!sectionId) {
      this._onDidChangeTreeData.fire(undefined)
      return
    }
    const node = this.section(sectionId)
    if (node) this._onDidChangeTreeData.fire(node)
  }

  /** Parents are known for section rows only — enough for TreeView.reveal(section). */
  getParent(element: Element): SectionNode | undefined {
    if (!(element instanceof SectionNode)) return undefined
    for (const [parent, kids] of this.children) if (kids.includes(element)) return parent
    return undefined
  }

  getTreeItem(element: Element): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (element instanceof SectionNode) {
      const { spec } = element
      const item = new vscode.TreeItem(
        spec.label,
        spec.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      )
      item.id = `section:${spec.id}`
      item.iconPath = new vscode.ThemeIcon(spec.icon)
      item.description = spec.describe?.()
      item.contextValue = spec.contextValue ?? `section.${spec.id}`
      return item
    }
    if (element instanceof PlaceholderNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None)
      item.iconPath = new vscode.ThemeIcon(element.icon)
      item.command = element.command
      return item
    }
    const section = this.owner.get(element)
    if (!section?.spec.provider) return new vscode.TreeItem('?')
    return section.spec.provider.getTreeItem(element)
  }

  async getChildren(element?: Element): Promise<Element[]> {
    if (!element) return this.roots.filter((n) => n.spec.visible?.() ?? true)
    if (element instanceof PlaceholderNode) return []

    const section = element instanceof SectionNode ? element : this.owner.get(element)
    if (!section) return []
    const nested = element instanceof SectionNode ? (this.children.get(section) ?? []).filter((n) => n.spec.visible?.() ?? true) : []
    const provider = section.spec.provider
    const own = provider ? ((await provider.getChildren(element instanceof SectionNode ? undefined : element)) ?? []) : []
    for (const child of own) {
      if (child !== null && typeof child === 'object') this.owner.set(child, section)
    }
    const all: Element[] = [...nested, ...own]
    if (element instanceof SectionNode && all.length === 0 && section.spec.empty) {
      const { label, command, icon } = section.spec.empty
      return [new PlaceholderNode(label, icon ?? 'info', command)]
    }
    return all
  }

  /** Lets providers' own `resolveTreeItem` (tooltips loaded lazily) keep working. */
  resolveTreeItem(item: vscode.TreeItem, element: Element, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    if (element instanceof SectionNode || element instanceof PlaceholderNode) return item
    const provider = this.owner.get(element)?.spec.provider
    return provider?.resolveTreeItem ? provider.resolveTreeItem(item, element, token) : item
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
