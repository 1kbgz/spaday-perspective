import { isActionColumn, type RowActions } from "./row-actions.js";
import type { Workspace } from "./workspace.js";

interface ViewConfig {
  table?: string;
  plugin?: string;
  columns?: (string | null)[];
  expressions?: Record<string, string>;
  sort?: unknown[][];
  filter?: unknown[][];
}

interface Viewer extends HTMLElement {
  saveWorkspace(): Promise<unknown>;
  getViewConfig(options: { panel: string }): Promise<ViewConfig>;
  getTable(options: { panel: string; wait: boolean }): Promise<{
    get_index(): Promise<string>;
    get_name(): Promise<string>;
    schema(): Promise<Record<string, string>>;
  }>;
  restore(config: ViewConfig, options: { panel: string }): Promise<void>;
}

type OwnedColumn = { key: string; expression: string };

/** Synthetic columns belong to views, never to source records or tables. */
export function installActionColumns(
  host: HTMLElement,
  viewer: Viewer,
  actions: () => RowActions,
  schedule: (step: () => Promise<void>) => Promise<unknown>,
) {
  const owned = new Map<string, Map<string, OwnedColumn>>();
  const tables = new Map<string, string>();
  let pending: Promise<void> | undefined;
  let requested = false;
  let disposed = false;

  function strip(
    config: ViewConfig,
    columns: Map<string, OwnedColumn>,
  ): ViewConfig {
    const result = structuredClone(config);
    const removed = new Set(
      [...columns]
        .filter(
          ([name, entry]) => result.expressions?.[name] === entry.expression,
        )
        .map(([name]) => name),
    );
    for (const name of removed) delete result.expressions?.[name];
    if (result.columns)
      result.columns = result.columns.filter((name) => !removed.has(name!));
    if (result.sort)
      result.sort = result.sort.filter((rule) => !removed.has(String(rule[0])));
    if (result.filter)
      result.filter = result.filter.filter(
        (rule) => !removed.has(String(rule[0])),
      );
    return result;
  }

  async function reconcile() {
    if (
      !owned.size &&
      !Object.values(actions()).some((policy) =>
        Object.values(policy).some(isActionColumn),
      )
    )
      return;
    const workspace = (await viewer.saveWorkspace()) as Workspace;
    const panels = workspace.panels ?? {};
    for (const id of owned.keys())
      if (!(id in panels)) {
        owned.delete(id);
        tables.delete(id);
      }
    for (const id of Object.keys(panels)) {
      if (disposed) return;
      const config = await viewer.getViewConfig({ panel: id });
      const source = await viewer.getTable({ panel: id, wait: false });
      // A pending wait_for_table panel has no table yet.
      if (!source) continue;
      const name = await source.get_name();
      tables.set(id, name);
      const policy = Object.prototype.hasOwnProperty.call(actions(), name)
        ? actions()[name]
        : {};
      const rules = Object.entries(policy).filter(([, rule]) =>
        isActionColumn(rule),
      );
      const previous = owned.get(id) ?? new Map<string, OwnedColumn>();
      if (!rules.length && !previous.size) continue;
      const clean = strip(config, previous);
      const next = new Map<string, OwnedColumn>();
      const expressions = { ...clean.expressions };
      const start: string[] = [],
        end: string[] = [];
      if (!config.plugin || config.plugin === "Datagrid") {
        const [schema, index] = await Promise.all([
          source.schema(),
          source.get_index(),
        ]);
        for (const [key, rule] of rules) {
          if (!isActionColumn(rule) || !rule.buttons.length) continue;
          if (
            Object.prototype.hasOwnProperty.call(schema, rule.header) ||
            Object.prototype.hasOwnProperty.call(expressions, rule.header)
          )
            throw new Error(
              `Action column ${key}: header ${JSON.stringify(rule.header)} conflicts with an existing column or expression`,
            );
          const expression = index ? JSON.stringify(index) : "0";
          Object.defineProperty(expressions, rule.header, {
            value: expression,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          next.set(rule.header, { key, expression });
          (rule.position === "start" ? start : end).push(rule.header);
        }
      }
      const columns = [...start, ...(clean.columns ?? []), ...end];
      const patch: ViewConfig = { expressions, columns };
      for (const key of ["sort", "filter"] as const) {
        const retained = config[key]?.filter(
          (rule) => !previous.has(String(rule[0])) || next.has(String(rule[0])),
        );
        if (JSON.stringify(retained) !== JSON.stringify(config[key]))
          patch[key] = retained;
      }
      if (disposed) return;
      // Publish the mapping before restore draws cells; roll it back on failure.
      owned.set(id, next);
      if (
        Object.entries(patch).every(
          ([key, value]) =>
            JSON.stringify(config[key as keyof ViewConfig]) ===
            JSON.stringify(value),
        )
      )
        continue;
      try {
        await viewer.restore(patch, { panel: id });
      } catch (error) {
        owned.set(id, previous);
        throw error;
      }
    }
  }

  function refresh(): Promise<void> {
    requested = true;
    pending ??= Promise.resolve()
      .then(async () => {
        while (requested && !disposed) {
          requested = false;
          await reconcile();
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  const changed = () => {
    void schedule(refresh).catch((error) => {
      if (!disposed)
        host.dispatchEvent(
          new CustomEvent("perspective-error", {
            detail: error,
            bubbles: true,
            composed: true,
          }),
        );
    });
  };
  viewer.addEventListener("perspective-config-update", changed);
  return {
    refresh,
    connect() {
      disposed = false;
      viewer.addEventListener("perspective-config-update", changed);
    },
    columnKey: (panel: string, header: string) =>
      owned.get(panel)?.get(header)?.key,
    cleanConfig<T extends ViewConfig>(config: T): T {
      const columns = new Map(
        [...owned]
          .filter(([id]) => tables.get(id) === config.table)
          .flatMap(([, value]) => [...value]),
      );
      return strip(config, columns) as T;
    },
    clean(workspace: Workspace): Workspace {
      const result = structuredClone(workspace);
      for (const [id, config] of Object.entries(result.panels ?? {})) {
        Object.assign(
          config,
          strip(config as ViewConfig, owned.get(id) ?? new Map()),
        );
      }
      return result;
    },
    dispose() {
      disposed = true;
      viewer.removeEventListener("perspective-config-update", changed);
    },
  };
}
