export interface ClipboardViewer extends HTMLElement {
  getSelection(options: { panel: string }): unknown;
  export(options: { method: string; panel: string }): Promise<string | Blob>;
}

/** Component-scoped compatibility for Perspective 5.5's selected-cell clipboard path. */
export function installClipboard(
  host: HTMLElement,
  viewer: ClipboardViewer,
): { dispose(): void; copySelection(): Promise<boolean> } {
  const controller = new AbortController();
  const doc = host.ownerDocument;
  const browser = doc.defaultView!;
  const options = { capture: true, signal: controller.signal };
  let generation = 0;
  let focusedGrid: HTMLElement | undefined;
  const invalidate = () => {
    generation++;
  };
  const report = (error: unknown) =>
    host.dispatchEvent(
      new CustomEvent("perspective-copy-error", {
        detail: {
          message:
            "Copy failed. Select cells and try again, or use Perspective's Export menu to download the data.",
          error,
        },
        bubbles: true,
        composed: true,
      }),
    );
  const gridIn = (event: Event) =>
    event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.matches("perspective-viewer-datagrid") &&
          node.closest("perspective-panel") === host,
      );
  const editable = (event: Event) =>
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("input, textarea, select") || node.isContentEditable),
      );
  const textCopy = (text: string) => {
    let copied = false;
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      event.stopImmediatePropagation();
      copied = true;
    };
    doc.addEventListener("copy", onCopy, true);
    try {
      return doc.execCommand("copy") && copied;
    } finally {
      doc.removeEventListener("copy", onCopy, true);
    }
  };
  const copySelection = async (): Promise<boolean> => {
    const grid = focusedGrid;
    if (!grid?.slot || !grid.isConnected || !host.isConnected) return false;
    const selection = viewer.getSelection({ panel: grid.slot });
    if (!selection) return false;
    const snapshot = JSON.stringify(selection);
    const request = ++generation;
    const current = () =>
      request === generation &&
      host.isConnected &&
      grid.isConnected &&
      doc.hasFocus() &&
      JSON.stringify(viewer.getSelection({ panel: grid.slot })) === snapshot;
    try {
      const text = Promise.resolve(
        viewer.export({ method: "plugin", panel: grid.slot }),
      ).then((value) => (typeof value === "string" ? value : value.text()));
      // Both promises need rejection handlers when a denied write never consumes its item.
      const blob = text.then((value) => {
        if (!current()) throw new DOMException("Copy cancelled", "AbortError");
        return new Blob([value], { type: "text/plain" });
      });
      void blob.catch(() => {});
      if (
        browser.isSecureContext &&
        browser.navigator.clipboard?.write &&
        typeof ClipboardItem !== "undefined"
      ) {
        try {
          await browser.navigator.clipboard.write([
            new ClipboardItem({ "text/plain": blob }),
          ]);
          return current();
        } catch {
          if (!current()) return false;
        }
      }
      const value = await text;
      if (!current()) return false;
      if (
        browser.navigator.userActivation?.isActive === false ||
        !textCopy(value)
      )
        throw new Error("Clipboard access unavailable");
      return true;
    } catch (error) {
      if (current()) report(error);
      return false;
    }
  };
  doc.addEventListener(
    "pointerdown",
    (event) => {
      invalidate();
      const grid = gridIn(event);
      if (grid) focusedGrid = grid;
      else if (!event.composedPath().includes(host)) focusedGrid = undefined;
    },
    options,
  );
  doc.addEventListener(
    "focusin",
    (event) => {
      invalidate();
      const grid = gridIn(event);
      if (grid) focusedGrid = grid;
      else if (!event.composedPath().includes(host)) focusedGrid = undefined;
    },
    options,
  );
  doc.addEventListener("selectionchange", invalidate, options);
  browser.addEventListener("blur", invalidate, options);
  host.addEventListener("perspective-select", invalidate, options);
  host.addEventListener("perspective-config-update", invalidate, options);
  const guardMenu = (event: Event) => {
    const path = event.composedPath();
    if (
      !browser.isSecureContext &&
      path.some(
        (node) =>
          node instanceof Element && node.matches("perspective-copy-menu"),
      ) &&
      path.some(
        (node) =>
          node instanceof Element && node.matches(".dropdown-menu-item"),
      )
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      report(
        new Error(
          "Perspective's Copy menu requires HTTPS. Use Copy selection or Ctrl+C / Cmd+C, or export the data.",
        ),
      );
      return true;
    }
    return false;
  };
  host.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") invalidate();
      if ((event.key === "Enter" || event.key === " ") && guardMenu(event))
        return;
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "c" ||
        event.defaultPrevented ||
        editable(event) ||
        browser.getSelection()?.toString()
      )
        return;
      const grid = gridIn(event);
      if (!grid?.slot || !viewer.getSelection({ panel: grid.slot })) return;
      focusedGrid = grid;
      event.preventDefault();
      event.stopPropagation();
      void copySelection();
    },
    options,
  );
  host.addEventListener(
    "mousedown",
    (event) => {
      if (guardMenu(event)) return;
      const grid = gridIn(event);
      if (
        event.button === 2 &&
        !event.shiftKey &&
        !event.defaultPrevented &&
        grid?.slot &&
        viewer.getSelection({ panel: grid.slot })
      )
        event.stopPropagation();
    },
    options,
  );
  return {
    copySelection,
    dispose() {
      invalidate();
      controller.abort();
      focusedGrid = undefined;
    },
  };
}
