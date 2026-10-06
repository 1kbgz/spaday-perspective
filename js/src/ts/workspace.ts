export interface PanelConfig {
  table: string;
  title?: string;
  theme?: string;
  plugin_config?: {
    columns?: Record<string, { column_size_override?: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type Layout =
  | { type: "tab-layout"; tabs: string[]; selected?: number }
  | {
      type: "split-layout";
      children: Layout[];
      sizes: number[];
      orientation: string;
    };

export interface Workspace {
  layout?: Layout | null;
  panels?: Record<string, PanelConfig>;
  masters?: string[];
  active?: string | null;
  closed_channels?: Record<string, PanelConfig>;
  [key: string]: unknown;
}

interface LegacyNode {
  type: string;
  widgets?: string[];
  currentIndex?: number;
  children?: LegacyNode[];
  sizes?: number[];
  orientation?: string;
}

function migrateNode(node: LegacyNode): Layout {
  if (node.type === "tab-area")
    return {
      type: "tab-layout",
      tabs: node.widgets ?? [],
      selected: node.currentIndex ?? 0,
    };
  const children = (node.children ?? []).map(migrateNode);
  return {
    type: "split-layout",
    orientation: node.orientation ?? "horizontal",
    sizes: node.sizes?.length
      ? node.sizes
      : children.map(() => 1 / children.length),
    children,
  };
}

/** Convert a v4 workspace envelope; v5 configurations pass through unchanged. */
export function migrateLayout(workspace: Workspace): Workspace {
  if (!("viewers" in workspace) || "panels" in workspace) return workspace;
  const { viewers, detail, master, sizes, ...rest } =
    structuredClone(workspace);
  const result: Workspace = {
    ...rest,
    panels: (viewers ?? {}) as Record<string, PanelConfig>,
  };
  const root = (detail as { main?: LegacyNode } | null)?.main;
  if (root) result.layout = migrateNode(root);
  const masters = master as { widgets?: string[]; sizes?: number[] } | null;
  if (masters?.widgets?.length) {
    result.masters = masters.widgets;
    const masterLayout: Layout = {
      type: "split-layout",
      orientation: "vertical",
      sizes: masters.sizes?.length
        ? masters.sizes
        : masters.widgets.map(() => 1 / masters.widgets!.length),
      children: masters.widgets.map((id) => ({
        type: "tab-layout",
        tabs: [id],
        selected: 0,
      })),
    };
    result.layout = result.layout
      ? {
          type: "split-layout",
          orientation: "horizontal",
          sizes: (sizes as number[] | undefined)?.length
            ? (sizes as number[])
            : [0.25, 0.75],
          children: [masterLayout, result.layout],
        }
      : masterLayout;
  }
  return result;
}

/** Remove closed panels while retaining the selected tab and split proportions. */
export function pruneLayout(
  layout: Layout | null | undefined,
  keep: Set<string>,
): Layout | null {
  if (!layout) return null;
  if (layout.type === "tab-layout") {
    const selected = layout.tabs[layout.selected ?? 0];
    const tabs = layout.tabs.filter((id) => keep.has(id));
    return tabs.length
      ? { ...layout, tabs, selected: Math.max(0, tabs.indexOf(selected)) }
      : null;
  }
  const children: Layout[] = [];
  const sizes: number[] = [];
  layout.children.forEach((child, index) => {
    const kept = pruneLayout(child, keep);
    if (kept) {
      children.push(kept);
      sizes.push(layout.sizes[index]);
    }
  });
  if (children.length === 1) return children[0];
  return children.length ? { ...layout, children, sizes } : null;
}

export function tabStacks(
  layout: Layout | null | undefined,
): Extract<Layout, { type: "tab-layout" }>[] {
  if (!layout) return [];
  return layout.type === "tab-layout"
    ? [layout]
    : layout.children.flatMap(tabStacks);
}
