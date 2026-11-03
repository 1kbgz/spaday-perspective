const styled = new WeakSet<HTMLElement>();

/** Perspective 5.6 keeps its frames inside the viewer's shadow root. Own the
 * compatibility styles here; applications only need the public color tokens. */
export function styleWorkspace(viewer: HTMLElement): void {
  const root = viewer.shadowRoot;
  if (!root || styled.has(viewer)) return;
  styled.add(viewer);
  const style = new CSSStyleSheet();
  style.replaceSync(`
    :host(perspective-viewer) #main_panel_container regular-layout {
      background: var(--spa-perspective-divider-color, var(--psp-inactive--border-color, #b8bec5));
    }
    :host(perspective-viewer) #main_panel_container regular-layout[data-spaday-resizing] {
      background: var(--spa-perspective-divider-hover-color, var(--psp-active--color, #2670a9));
    }
    :host(perspective-viewer) #main_panel_container regular-layout > .rl-panel {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border-color: var(--spa-perspective-divider-color, var(--psp-inactive--border-color, #b8bec5));
    }
    :host(perspective-viewer) #main_panel_container regular-layout > .rl-panel::part(titlebar) {
      min-width: 0;
      overflow: hidden;
      flex-shrink: 0;
    }
    :host(perspective-viewer) #main_panel_container regular-layout > .rl-panel::part(container) {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
  `);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, style];
  // The engine owns hit testing and cursor state. Read that result after its
  // pointer handler rather than duplicating its divider geometry.
  root.addEventListener("pointermove", (event) => {
    const layout = (event.target as Element).closest("regular-layout");
    if (layout)
      layout.toggleAttribute(
        "data-spaday-resizing",
        /^(col|row)-resize$/.test(getComputedStyle(layout).cursor),
      );
  });
  viewer.addEventListener("pointerleave", () => {
    root
      .querySelectorAll("[data-spaday-resizing]")
      .forEach((layout) => layout.removeAttribute("data-spaday-resizing"));
  });
}
