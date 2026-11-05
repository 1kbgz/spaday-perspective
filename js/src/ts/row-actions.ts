export interface RowAction {
  action: string;
  label: string;
  text?: string;
  icon?: "copy" | "delete" | "add" | "share";
}

export interface ActionColumn {
  header: string;
  position: "start" | "end";
  buttons: RowAction[];
}

export function isActionColumn(
  rule: RowAction | RowAction[] | ActionColumn,
): rule is ActionColumn {
  return !Array.isArray(rule) && "buttons" in rule;
}

/** The expression behind a generated action column: the index column itself for a single index,
 * so the cell carries the row key; a literal for multi-column or absent indexes, where the key is
 * read from the view's row identities instead. */
export function actionExpression(index: string | string[] | undefined): string {
  return typeof index === "string" ? JSON.stringify(index) : "0";
}

/** Table name → indexed column or dedicated column identifier → actions. */
export type RowActions = Record<
  string,
  Record<string, RowAction | RowAction[] | ActionColumn>
>;

interface ActionDetail {
  action: string;
  panel: string;
  table: string;
  column: string;
  /** The row's index value, or its index values in index order for a multi-column index. */
  key: string | number | (string | number)[];
}

const scalar = (value: unknown): value is string | number =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isSafeInteger(value));

/** A button's detail before activation: a multi-column key is resolved on activation. */
type PendingDetail = Omit<ActionDetail, "key"> & { key?: ActionDetail["key"] };

interface ActionViewer extends HTMLElement {
  getViewConfig(options: { panel: string }): Promise<{
    group_by?: string[];
    split_by?: string[];
    expressions?: Record<string, string>;
  }>;
  getTable(options: { panel: string; wait: boolean }): Promise<{
    get_index(): Promise<string | string[] | undefined>;
    get_name(): Promise<string>;
  }>;
  /** The panel's live View, owned by the viewer: read from it, never delete it. */
  getView(options: { panel: string; mode: "live" }): Promise<{
    to_columns(window: {
      start_row: number;
      end_row: number;
      id: boolean;
    }): Promise<object>;
  }>;
}

interface Grid extends HTMLElement {
  regular_table: HTMLElement & {
    addStyleListener(callback: () => Promise<void>): () => void;
    getMeta(
      cell: HTMLElement,
    ): { column_header?: unknown[]; user?: unknown; y?: number } | undefined;
    draw(): Promise<void>;
  };
}

/** Scoped to the pinned Datagrid's public regular_table extension surface. */
export function installRowActions(
  host: HTMLElement,
  viewer: ActionViewer,
  actions: () => RowActions,
  columnKey: (panel: string, header: string) => string | undefined = () =>
    undefined,
) {
  const attached = new Map<Grid, { dispose(): void; refresh(): void }>();
  let disposed = false;
  const report = (error: unknown) =>
    host.dispatchEvent(
      new CustomEvent("perspective-error", {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    );
  const attach = (grid: Grid) => {
    const table = grid.regular_table;
    const controller = new AbortController();
    const details = new WeakMap<HTMLButtonElement, PendingDetail>();
    // Buttons on a multi-column index: the row to resolve and how many index values it has.
    const rows = new WeakMap<
      HTMLButtonElement,
      { row: number; width: number }
    >();
    let gesture: { button: HTMLButtonElement; detail: string } | undefined;
    // One row's identity from the panel's live View, owned by the viewer (read, never deleted).
    // For a flat view `__ID__` is the key tuple wrapped in a one-element row path.
    const resolveKey = async (row: number): Promise<unknown> => {
      const view = await viewer.getView({ panel: grid.slot, mode: "live" });
      const { __ID__ } = (await view.to_columns({
        start_row: row,
        end_row: row + 1,
        id: true,
      })) as { __ID__?: unknown[] };
      const path = __ID__?.[0];
      return Array.isArray(path) && path.length === 1 ? path[0] : undefined;
    };
    let generation = 0;
    const style = async () => {
      const version = ++generation;
      const config = await viewer.getViewConfig({ panel: grid.slot });
      const source = await viewer.getTable({ panel: grid.slot, wait: false });
      const name = await source.get_name();
      const policy = Object.prototype.hasOwnProperty.call(actions(), name)
        ? actions()[name]
        : {};
      const index = Object.keys(policy).length
        ? (await source.get_index()) || undefined
        : undefined;
      const multi = Array.isArray(index) ? index : undefined;
      if (disposed || controller.signal.aborted || version !== generation)
        return;
      for (const cell of table.querySelectorAll<HTMLTableCellElement>(
        "tbody td",
      )) {
        const meta = table.getMeta(cell);
        const column = meta?.column_header?.[meta.column_header.length - 1];
        const actionColumn =
          typeof column === "string" &&
          config.expressions?.[column] === actionExpression(index)
            ? columnKey(grid.slot, column)
            : undefined;
        const policyKey = actionColumn ?? column;
        const rule =
          typeof policyKey === "string" &&
          Object.prototype.hasOwnProperty.call(policy, policyKey)
            ? policy[policyKey]
            : undefined;
        const old = [
          ...cell.querySelectorAll<HTMLButtonElement>(
            "button[data-perspective-row-action]",
          ),
        ];
        const rules = rule
          ? isActionColumn(rule)
            ? actionColumn
              ? rule.buttons
              : []
            : Array.isArray(rule)
              ? rule
              : [rule]
          : [];
        if (!rules.length || typeof column !== "string") {
          if (old.length) cell.textContent = String(meta?.user ?? "");
          continue;
        }
        // A single index is the action cell's own value. A multi-column key has no cell to live
        // in; it is resolved from the view's row identity when a button is activated, so drawing
        // costs no engine query.
        const key: unknown = multi ? undefined : meta?.user;
        const indexColumn = multi ? multi.includes(column) : column === index;
        const reason =
          config.group_by?.length || config.split_by?.length
            ? "Row actions require an ungrouped, unsplit table"
            : !index || (!indexColumn && !actionColumn)
              ? "Row actions require the table's indexed column"
              : !multi && !scalar(key)
                ? "Row action has no supported record key"
                : "";
        const buttons = rules.map((rule, position) => {
          const detail = {
            action: rule.action,
            panel: grid.slot,
            table: name,
            column: actionColumn ?? column,
            key: key as ActionDetail["key"] | undefined,
          };
          const button =
            old[position] &&
            JSON.stringify(details.get(old[position])) ===
              JSON.stringify(detail)
              ? old[position]
              : document.createElement("button");
          button.type = "button";
          button.dataset.perspectiveRowAction = rule.action;
          button.replaceChildren();
          if (rule.icon) {
            const svg = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "svg",
            );
            svg.setAttribute("viewBox", "0 0 16 16");
            svg.setAttribute("width", "14");
            svg.setAttribute("height", "14");
            svg.setAttribute("aria-hidden", "true");
            svg.setAttribute("focusable", "false");
            svg.style.verticalAlign = "middle";
            const path = document.createElementNS(svg.namespaceURI, "path");
            path.setAttribute(
              "d",
              {
                share:
                  "M6 10l4-4 M5 7L3 9a3 3 0 004 4l2-2 M7 5l2-2a3 3 0 014 4l-2 2",
                copy: "M5 5h8v8H5z M3 10H2V2h8v1",
                delete: "M4 4l8 8M12 4l-8 8",
                add: "M8 3v10M3 8h10",
              }[rule.icon],
            );
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "currentColor");
            path.setAttribute("stroke-width", "1.5");
            svg.append(path);
            button.append(svg);
          }
          if (rule.text !== undefined || !rule.icon)
            button.append(rule.text ?? "×");
          button.setAttribute("aria-label", rule.label);
          button.title = reason || rule.label;
          button.disabled = !!reason;
          button.style.cssText =
            "font:inherit;cursor:pointer;color:var(--spa-perspective-action-color,inherit);background:var(--spa-perspective-action-background,transparent);border:1px solid var(--spa-perspective-action-border,currentColor);border-radius:3px;padding:0 6px";
          button.style.marginInlineEnd =
            position < rules.length - 1 ? "4px" : "0";
          details.set(button, detail);
          if (multi)
            rows.set(button, { row: meta?.y ?? 0, width: multi.length });
          else rows.delete(button);
          return button;
        });
        if (
          buttons.length !== old.length ||
          buttons.some((button, i) => button !== old[i])
        )
          cell.replaceChildren(...buttons);
      }
    };
    const intercept = (event: Event) => {
      const button = event
        .composedPath()
        .find(
          (node): node is HTMLButtonElement =>
            node instanceof HTMLButtonElement && details.has(node),
        );
      if (!button) return;
      event.stopImmediatePropagation();
      const detail = details.get(button)!;
      const pending = rows.get(button);
      // What the button stands for: its detail, plus its row on a multi-column index.
      const identity = JSON.stringify([detail, pending?.row]);
      if (event.type === "pointerdown") gesture = { button, detail: identity };
      if (event.type === "click") {
        event.preventDefault();
        if (button.disabled || !host.isConnected || !grid.isConnected) return;
        // Virtualized cells may change identity between pointerdown and click.
        if (
          (event as MouseEvent).detail > 0 &&
          (gesture?.button !== button || gesture.detail !== identity)
        )
          return;
        gesture = undefined;
        const dispatch = (key: ActionDetail["key"]) => {
          if (!host.isConnected || !grid.isConnected) return;
          host.dispatchEvent(
            new CustomEvent("perspective-row-action", {
              detail: { ...detail, key },
              bubbles: true,
              composed: true,
            }),
          );
        };
        if (!pending) {
          dispatch(detail.key!);
          return;
        }
        void (async () => {
          const key = await resolveKey(pending.row);
          if (
            !Array.isArray(key) ||
            key.length !== pending.width ||
            !key.every(scalar)
          )
            throw new Error("Row action has no supported record key");
          dispatch(key);
        })().catch((error) => {
          if (!controller.signal.aborted) report(error);
        });
      }
    };
    for (const type of [
      "pointerdown",
      "mousedown",
      "click",
      "dblclick",
      "keydown",
      "keyup",
      "focusin",
    ])
      table.addEventListener(type, intercept, {
        capture: true,
        signal: controller.signal,
      });
    const unsubscribe = table.addStyleListener(async () => {
      try {
        await style();
      } catch (error) {
        if (!controller.signal.aborted) report(error);
      }
    });
    const dispose = () => {
      generation++;
      controller.abort();
      unsubscribe();
      const cells = new Set(
        [...table.querySelectorAll("button[data-perspective-row-action]")].map(
          (button) => button.parentElement!,
        ),
      );
      for (const cell of cells) {
        cell.textContent = String(table.getMeta(cell)?.user ?? "");
      }
    };
    attached.set(grid, {
      dispose,
      refresh() {
        if (table.querySelector("tbody td"))
          void style().catch((error) => {
            if (!controller.signal.aborted) report(error);
          });
      },
    });
  };
  const reconcile = () => {
    for (const [grid, adapter] of attached) {
      if (!viewer.contains(grid) || !Object.keys(actions()).length) {
        adapter.dispose();
        attached.delete(grid);
      }
    }
    if (disposed || !Object.keys(actions()).length) return;
    for (const grid of viewer.querySelectorAll<Grid>(
      "perspective-viewer-datagrid",
    )) {
      if (!attached.has(grid)) attach(grid);
    }
  };
  const refresh = () => {
    reconcile();
    for (const adapter of attached.values()) adapter.refresh();
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(viewer, { childList: true });
  viewer.addEventListener("perspective-config-update", reconcile);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      observer.disconnect();
      viewer.removeEventListener("perspective-config-update", reconcile);
      for (const adapter of attached.values()) adapter.dispose();
      attached.clear();
    },
  };
}
