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
