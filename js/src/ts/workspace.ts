import perspective from "@perspective-dev/client";
import type { Validator } from "@perspective-dev/client";
import type { WorkspaceConfigUpdate } from "@perspective-dev/viewer";
import { errorMessage } from "./config.js";
// The entry re-exports the workspace and viewer config types but not their constituents; these
// are the same generated declarations, reached through the package's `./dist/*` export.
import type { Layout } from "@perspective-dev/viewer/dist/ts-rs/Layout.d.ts";
import type { ViewerConfigInitial } from "@perspective-dev/viewer/dist/ts-rs/ViewerConfigInitial.d.ts";

export type { Layout };

export type PanelConfig = ViewerConfigInitial;

export type Workspace = Omit<
  WorkspaceConfigUpdate,
  "layout" | "panels" | "active"
> & {
  layout?: Layout | null;
  panels?: Record<string, PanelConfig>;
  active?: string | null;
  retained_panel_configs_by_table?: Record<string, PanelConfig>;
  /** Compatibility metadata key used by save() and saveClean(). */
  closed_channels?: Record<string, PanelConfig>;
};

export type MigrateNotice =
  | { kind: "Dropped"; step: string; pointer: string; value: unknown }
  | { kind: "Approximated"; step: string; pointer: string; reason: string };

export interface MigratedWorkspace {
  value: Workspace;
  notices: MigrateNotice[];
}

export function describeNotice(notice: MigrateNotice): string {
  return notice.kind === "Dropped"
    ? `dropped by ${notice.step}, no current form for ${JSON.stringify(notice.value)}`
    : `${notice.reason} (${notice.step})`;
}

declare const __PERSPECTIVE_VERSION__: string;

// `migrate()` takes an unstamped layout as written by 2.0.0, which would rewrite a hand-written
// current layout as a two-decade-old token (a chart's `plugin_config` emptied as pre-d3fc
// leftovers). Only a Perspective 4 envelope is left to that default; its panels carry their own
// stamps when they were ever saved.
function writtenBy(layout: Record<string, unknown>): string | undefined {
  if ("version" in layout || ("viewers" in layout && !("panels" in layout)))
    return undefined;
  return __PERSPECTIVE_VERSION__;
}

// The wrapper's own workspace keys, which `migrate()` does not know and so would drop.
const METADATA = [
  "retained_panel_configs_by_table",
  "closed_channels",
] as const;

// Perspective's schema check needs its `migrate` binary. Awaited at the top level, the fetch would
// hold the bundle back past the page's `load` (see `ready` in the entry); instead the panel's
// queue waits on it, and `config` checks a layout in the setter once it is here.
export let validator: Validator | undefined;
export const validatorReady: Promise<void> = perspective
  .create_validator()
  .then(
    (loaded) => {
      validator = loaded;
    },
    (error: unknown) => {
      console.warn("perspective-panel: schema validation unavailable", error);
    },
  );

function migrateNow(workspace: unknown): MigratedWorkspace {
  const parsed: unknown =
    typeof workspace === "string" ? JSON.parse(workspace) : workspace;
  const plain =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Workspace)
      : undefined;
  if (!validator)
    return { value: structuredClone(parsed) as Workspace, notices: [] };
  const rest = { ...plain };
  for (const key of METADATA) delete rest[key];
  const { value, notices } = validator.migrate<Workspace>(
    "workspace",
    plain ? rest : parsed,
    plain && writtenBy(plain),
  );
  for (const key of METADATA)
    if (plain && key in plain) value[key] = structuredClone(plain[key]);
  return { value, notices };
}

export async function migrateWorkspace(
  workspace: unknown,
): Promise<MigratedWorkspace> {
  await validatorReady;
  return migrateNow(workspace);
}

export async function migrateLayout(layout: unknown): Promise<Workspace> {
  const { value, notices } = await migrateWorkspace(layout);
  for (const notice of notices)
    console.warn(`layout${notice.pointer}: ${describeNotice(notice)}`);
  return value;
}

export function migrateConfig(workspace: unknown, path: string): Workspace {
  let migrated: MigratedWorkspace;
  try {
    migrated = migrateNow(workspace);
  } catch (error) {
    throw new TypeError(`${path}: ${errorMessage(error)}`);
  }
  const dropped = migrated.notices.filter((n) => n.kind === "Dropped");
  if (dropped.length)
    throw new TypeError(
      dropped
        .map((n) => `${path}${n.pointer}: ${describeNotice(n)}`)
        .join("; "),
    );
  for (const notice of migrated.notices)
    console.warn(`${path}${notice.pointer}: ${describeNotice(notice)}`);
  return migrated.value;
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
