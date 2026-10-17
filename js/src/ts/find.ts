type Filter = [string, string, unknown];
export interface FindViewer extends HTMLElement {
  getActivePanel(): string | null;
  getSelection(options: { panel: string }): { start_col?: number } | undefined;
  getViewConfig(options: { panel: string }): Promise<{
    columns?: (string | null)[];
    filter?: Filter[];
    filter_op?: string;
    split_by?: string[];
  }>;
  getTable(options: { panel: string; wait: boolean }): Promise<{
    schema(): Promise<Record<string, string>>;
    get_name(): Promise<string>;
  }>;
  restore(config: unknown, options: { panel: string }): Promise<void>;
}

/** Column-scoped equality filtering; never exports or scans rows in the browser. */
export function installFind(
  host: HTMLElement,
  viewer: FindViewer,
  enabled: () => boolean,
) {
  const controller = new AbortController();
  let dialog: HTMLDialogElement | undefined;
  let generation = 0;
  const cancel = () => {
    generation++;
    dialog?.close();
    dialog?.remove();
    dialog = undefined;
  };
  const open = async (panel = viewer.getActivePanel()) => {
    if (!enabled() || !panel || !host.isConnected) return;
    cancel();
    const request = generation;
    const box = document.createElement("dialog");
    dialog = box;
    box.setAttribute("aria-label", "Find in column");
    box.style.cssText =
      "color:var(--spa-text,CanvasText);background:var(--spa-surface,Canvas);border:1px solid currentColor;border-radius:.5rem;padding:1rem;max-width:calc(100vw - 4rem)";
    const form = document.createElement("form");
    form.style.cssText = "display:grid;gap:.75rem;min-width:16rem";
    const title = document.createElement("strong");
    title.textContent = "Find in column";
    const columnLabel = document.createElement("label");
    columnLabel.textContent = "Column ";
    const columns = document.createElement("select");
    columns.disabled = true;
    columnLabel.append(columns);
    const valueLabel = document.createElement("label");
    valueLabel.textContent = "Equals ";
    const input = document.createElement("input");
    input.disabled = true;
    valueLabel.append(input);
    const help = document.createElement("small");
    help.textContent =
      "Adds an exact-match filter. Existing filters remain; edit or remove filters in Settings.";
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.textContent = "Apply filter";
    apply.disabled = true;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Cancel";
    close.addEventListener("click", cancel);
    box.addEventListener("cancel", cancel);
    form.append(title, columnLabel, valueLabel, help, error, apply, close);
    box.append(form);
    host.append(box);
    box.showModal();
    const current = () =>
      request === generation && enabled() && host.isConnected && box.open;
    try {
      const table = await viewer.getTable({ panel, wait: false });
      const [schema, name, config] = await Promise.all([
        table.schema(),
        table.get_name(),
        viewer.getViewConfig({ panel }),
      ]);
      if (!current()) return;
      for (const [column, type] of Object.entries(schema))
        if (
          [
            "string",
            "integer",
            "float",
            "boolean",
            "date",
            "datetime",
          ].includes(type)
        )
          columns.append(new Option(column, column));
      if (!columns.options.length)
        throw new Error("No searchable source columns");
      const selected = viewer.getSelection({ panel })?.start_col;
      const column =
        !config.split_by?.length && selected !== undefined
          ? config.columns?.[selected]
          : undefined;
      if (column && Object.prototype.hasOwnProperty.call(schema, column))
        columns.value = column;
      const describe = () => {
        const type = schema[columns.value];
        input.type =
          type === "date"
            ? "date"
            : type === "datetime"
              ? "datetime-local"
              : "text";
        input.placeholder = type === "boolean" ? "true or false" : type;
        input.value = "";
        error.textContent = "";
      };
      columns.addEventListener("change", describe);
      describe();
      columns.disabled = false;
      input.disabled = false;
      apply.disabled = false;
      input.focus();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (apply.disabled || !current()) return;
        apply.disabled = true;
        error.textContent = "";
        try {
          const key = columns.value;
          const type = schema[key];
          const raw = input.value;
          let value: unknown = raw;
          if (type === "integer" || type === "float") {
            value = Number(raw);
            if (
              !raw.trim() ||
              !Number.isFinite(value) ||
              (type === "integer" && !Number.isSafeInteger(value))
            )
              throw new Error(`Enter a valid ${type}`);
          } else if (type === "boolean") {
            if (!["true", "false"].includes(raw.trim().toLowerCase()))
              throw new Error("Enter true or false");
            value = raw.trim().toLowerCase() === "true";
          } else if (type === "date" || type === "datetime") {
            value = Date.parse(raw);
            if (!raw || !Number.isFinite(value))
              throw new Error(`Enter a valid ${type}`);
          }
          const activeTable = await viewer.getTable({ panel, wait: false });
          if ((await activeTable.get_name()) !== name)
            throw new Error(
              "The panel changed tables. Close Find and try again.",
            );
          const latest = await viewer.getViewConfig({ panel });
          if (!current()) return;
          const filters = latest.filter ?? [];
          if (filters.length && latest.filter_op === "or")
            throw new Error(
              "Find requires AND filters. Change the filter combination in Settings first.",
            );
          const filter: Filter = [key, "==", value];
          if (
            !filters.some(
              (existing) => JSON.stringify(existing) === JSON.stringify(filter),
            )
          )
            await viewer.restore({ filter: [...filters, filter] }, { panel });
          if (current()) cancel();
        } catch (reason) {
          if (current())
            error.textContent = String(
              reason instanceof Error ? reason.message : reason,
            );
        } finally {
          if (current()) apply.disabled = false;
        }
      });
    } catch (reason) {
      if (current())
        error.textContent = String(
          reason instanceof Error ? reason.message : reason,
        );
    }
  };
  host.addEventListener(
    "keydown",
    (event) => {
      if (
        !enabled() ||
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      const path = event.composedPath();
      if (
        path.some(
          (node) =>
            node instanceof HTMLElement &&
            (node.matches("input,textarea,select") || node.isContentEditable),
        )
      )
        return;
      const grid = path.find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.matches("perspective-viewer-datagrid") &&
          node.closest("perspective-panel") === host,
      );
      if (!grid?.slot) return;
      event.preventDefault();
      event.stopPropagation();
      void open(grid.slot);
    },
    { capture: true, signal: controller.signal },
  );
  return {
    open,
    cancel,
    dispose() {
      controller.abort();
      cancel();
    },
  };
}
