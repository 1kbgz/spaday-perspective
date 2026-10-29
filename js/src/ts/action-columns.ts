import { isActionColumn, type RowActions } from "./row-actions.js";
import type { Workspace } from "./workspace.js";

interface ViewConfig {
  table?: string;
  plugin?: string;
  columns?: (string | null)[];
  expressions?: Record<string, string>;
  sort?: unknown[][];
  filter?: unknown[][];
  group_by?: string[];
  split_by?: string[];
  aggregates?: Record<string, unknown>;
  columns_config?: Record<string, unknown>;
  plugin_config?: { columns?: Record<string, unknown>; [key: string]: unknown };
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
  reconciled: () => void,
) {
  const owned = new Map<string, Map<string, OwnedColumn>>();
  const tables = new Map<string, string>();
  let pending: Promise<void> | undefined;
  let requested = false;
  let disposed = false;
  let revision = 0;
  const failures = new Map<string, string>();
  const dependencies = [
    "sort",
    "filter",
    "group_by",
    "split_by",
    "aggregates",
    "columns_config",
    "plugin_config",
  ] as const;

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
    for (const key of ["group_by", "split_by"] as const)
      if (result[key])
        result[key] = result[key].filter((name) => !removed.has(name));
    for (const mapping of [
      result.aggregates,
      result.columns_config,
      result.plugin_config?.columns,
    ])
      if (mapping) for (const name of removed) delete mapping[name];
    return result;
  }

  async function reconcile() {
    if (
      !owned.size &&
      !failures.size &&
      !Object.values(actions()).some((policy) =>
        Object.values(policy).some(isActionColumn),
      )
    )
      return;
    const workspace = (await viewer.saveWorkspace()) as Workspace;
    const panels = workspace.panels ?? {};
    for (const id of new Set([...owned.keys(), ...failures.keys()]))
      if (!(id in panels)) {
        owned.delete(id);
        tables.delete(id);
        failures.delete(id);
      }
    for (const id of Object.keys(panels)) {
      if (disposed) return;
      const version = revision;
      try {
        const snapshot = ((await viewer.saveWorkspace()) as Workspace).panels?.[
          id
        ];
        if (!snapshot) continue;
        const source = await viewer
          .getTable({ panel: id, wait: false })
          .catch((error) => {
            // Perspective rejects this query while a wait_for_table panel is pending.
            if (error instanceof Error && error.message === "No `Table` set")
              return undefined;
            throw error;
          });
        if (!source) {
          failures.delete(id);
          continue;
        }
        const name = await source.get_name();
        if (tables.get(id) !== name) owned.delete(id);
        tables.set(id, name);
        const policy = Object.prototype.hasOwnProperty.call(actions(), name)
          ? actions()[name]
          : undefined;
        const rules = Object.entries(policy ?? {}).filter(([, rule]) =>
          isActionColumn(rule),
        );
        const previous = owned.get(id) ?? new Map<string, OwnedColumn>();
        if (!rules.length && !previous.size) {
          failures.delete(id);
          continue;
        }
        const config: ViewConfig = {
          ...snapshot,
          ...(await viewer.getViewConfig({ panel: id })),
        };
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
        const removed = new Map(
          [...previous].filter(([header]) => !next.has(header)),
        );
        const cleaned = strip(config, removed);
        for (const key of dependencies)
          if (JSON.stringify(cleaned[key]) !== JSON.stringify(config[key]))
            Object.assign(patch, { [key]: cleaned[key] });
        if (disposed) return;
        const currentPolicy = Object.prototype.hasOwnProperty.call(
          actions(),
          name,
        )
          ? actions()[name]
          : undefined;
        if (version !== revision || policy !== currentPolicy) {
          requested = true;
          continue;
        }
        // Publish the mapping before restore draws cells; roll it back on failure.
        owned.set(id, next);
        if (
          Object.entries(patch).every(
            ([key, value]) =>
              JSON.stringify(config[key as keyof ViewConfig]) ===
              JSON.stringify(value),
          )
        ) {
          failures.delete(id);
          continue;
        }
        try {
          await viewer.restore(patch, { panel: id });
          failures.delete(id);
        } catch (error) {
          owned.set(id, previous);
          throw error;
        }
      } catch (error) {
        if (disposed) return;
        if (version !== revision) {
          requested = true;
          continue;
        }
        const message = String(error);
        if (failures.get(id) !== message) {
          failures.set(id, message);
          host.dispatchEvent(
            new CustomEvent("perspective-error", {
              detail: error,
              bubbles: true,
              composed: true,
            }),
          );
        }
      }
    }
    reconciled();
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
    revision++;
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
    isValid() {
      return failures.size === 0;
    },
    reset() {
      revision++;
      owned.clear();
      tables.clear();
      failures.clear();
    },
    connect() {
      disposed = false;
      viewer.addEventListener("perspective-config-update", changed);
      changed();
    },
    columnKey: (panel: string, header: string) =>
      failures.has(panel) ? undefined : owned.get(panel)?.get(header)?.key,
    dataConfig<T extends ViewConfig>(panel: string, config: T): T {
      const result = structuredClone(config);
      const columns = owned.get(panel);
      result.columns = result.columns?.filter(
        (name) =>
          !name ||
          !columns?.has(name) ||
          result.expressions?.[name] !== columns.get(name)!.expression,
      );
      return result;
    },
    cleanConfig<T extends ViewConfig>(config: T, panel?: string): T {
      const columns =
        panel && tables.get(panel) === config.table
          ? (owned.get(panel) ?? new Map())
          : new Map();
      return strip(config, columns) as T;
    },
    clean(workspace: Workspace): Workspace {
      const result = structuredClone(workspace);
      for (const [id, config] of Object.entries(result.panels ?? {})) {
        Object.assign(
          config,
          strip(
            config as ViewConfig,
            tables.get(id) === config.table
              ? (owned.get(id) ?? new Map())
              : new Map(),
          ),
        );
      }
      return result;
    },
    dispose() {
      disposed = true;
      revision++;
      viewer.removeEventListener("perspective-config-update", changed);
    },
  };
}
