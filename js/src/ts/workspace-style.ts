const styled = new WeakSet<HTMLElement>();

/** Perspective 5.6 keeps its frames inside the viewer's shadow root. Own the
 * compatibility styles here; applications only need the public color tokens. */
export function styleWorkspace(viewer: HTMLElement): void {
  const root = viewer.shadowRoot;
  if (!root || styled.has(viewer)) return;
  styled.add(viewer);

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
