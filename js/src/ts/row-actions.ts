export interface RowAction {
  action: string;
  label: string;
  text?: string;
}

/** Table name → indexed column → button description. */
export type RowActions = Record<string, Record<string, RowAction>>;

interface ActionDetail {
  action: string;
  panel: string;
  table: string;
  column: string;
  key: string | number;
}

interface ActionViewer extends HTMLElement {
  getViewConfig(options: {
    panel: string;
  }): Promise<{ group_by?: string[]; split_by?: string[] }>;
  getTable(options: {
    panel: string;
    wait: boolean;
  }): Promise<{ get_index(): Promise<string>; get_name(): Promise<string> }>;
}

interface Grid extends HTMLElement {
  regular_table: HTMLElement & {
    addStyleListener(callback: () => Promise<void>): () => void;
    getMeta(
      cell: HTMLElement,
    ): { column_header?: unknown[]; user?: unknown } | undefined;
    draw(): Promise<void>;
  };
}

/** Scoped to the pinned Datagrid's public regular_table extension surface. */
export function installRowActions(
  host: HTMLElement,
  viewer: ActionViewer,
  actions: () => RowActions,
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
    const details = new WeakMap<HTMLButtonElement, ActionDetail>();
    let gesture: { button: HTMLButtonElement; detail: string } | undefined;
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
        ? await source.get_index()
        : undefined;
      if (disposed || controller.signal.aborted || version !== generation)
        return;
      for (const cell of table.querySelectorAll<HTMLTableCellElement>(
        "tbody td",
      )) {
        const meta = table.getMeta(cell);
        const column = meta?.column_header?.[0];
        const rule =
          typeof column === "string" &&
          Object.prototype.hasOwnProperty.call(policy, column)
            ? policy[column]
            : undefined;
        const old = cell.querySelector<HTMLButtonElement>(
          "button[data-perspective-row-action]",
        );
        if (!rule || typeof column !== "string") {
          if (old) cell.textContent = String(meta?.user ?? "");
          continue;
        }
        const key = meta?.user;
        const supportedKey =
          typeof key === "string" ||
          (typeof key === "number" && Number.isSafeInteger(key));
        const reason =
          config.group_by?.length || config.split_by?.length
            ? "Row actions require an ungrouped, unsplit table"
            : column !== index
              ? "Row actions require the table's indexed column"
              : !supportedKey
                ? "Row action has no supported record key"
                : "";
        const detail = {
          action: rule.action,
          panel: grid.slot,
          table: name,
          column,
          key: key as string | number,
        };
        const button =
          old && JSON.stringify(details.get(old)) === JSON.stringify(detail)
            ? old
            : document.createElement("button");
        button.type = "button";
        button.dataset.perspectiveRowAction = rule.action;
        button.textContent = rule.text ?? "×";
        button.setAttribute("aria-label", rule.label);
        button.title = reason || rule.label;
        button.disabled = !!reason;
        button.style.cssText =
          "font:inherit;cursor:pointer;color:var(--spa-perspective-action-color,inherit);background:var(--spa-perspective-action-background,transparent);border:1px solid var(--spa-perspective-action-border,currentColor);border-radius:3px;padding:0 6px";
        details.set(button, detail);
        if (button !== old) cell.replaceChildren(button);
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
      if (event.type === "pointerdown")
        gesture = { button, detail: JSON.stringify(detail) };
      if (event.type === "click") {
        event.preventDefault();
        if (button.disabled || !host.isConnected || !grid.isConnected) return;
        // Virtualized cells may change identity between pointerdown and click.
        if (
          (event as MouseEvent).detail > 0 &&
          (gesture?.button !== button ||
            gesture.detail !== JSON.stringify(detail))
        )
          return;
        gesture = undefined;
        host.dispatchEvent(
          new CustomEvent("perspective-row-action", {
            detail: { ...detail },
            bubbles: true,
            composed: true,
          }),
        );
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
      for (const button of table.querySelectorAll(
        "button[data-perspective-row-action]",
      )) {
        const cell = button.parentElement!;
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
