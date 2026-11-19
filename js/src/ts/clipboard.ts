import type { HTMLPerspectiveViewerElement } from "@perspective-dev/viewer";
import { errorMessage } from "./config.js";

export type ClipboardViewer = HTMLElement &
  Pick<HTMLPerspectiveViewerElement, "copy">;

/** Ctrl+C and Cmd+C inside one of the host's grids copy that grid's selection through the
 * viewer's own `copy`, whose rejections (nothing selected, clipboard denied) are reported as
 * `perspective-copy-error`. Editable elements and native text selections keep their copying. */
export function installClipboard(
  host: HTMLElement,
  viewer: ClipboardViewer,
): { dispose(): void } {
  const controller = new AbortController();
  const browser = host.ownerDocument.defaultView!;
  host.addEventListener(
    "keydown",
    (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "c" ||
        event.defaultPrevented ||
        browser.getSelection()?.toString()
      )
        return;
      const path = event.composedPath();
      if (
        path.some(
          (node) =>
            node instanceof HTMLElement &&
            (node.matches("input, textarea, select") || node.isContentEditable),
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
      viewer.copy({ method: "csv-selected", panel: grid.slot }).catch((error) =>
        host.dispatchEvent(
          new CustomEvent("perspective-copy-error", {
            detail: { message: errorMessage(error), error },
            bubbles: true,
            composed: true,
          }),
        ),
      );
    },
    { capture: true, signal: controller.signal },
  );
  return {
    dispose() {
      controller.abort();
    },
  };
}
