// Icon masks the wrapper adds to Perspective's theme icons, for a command's `icon`.
const mask = (d: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='${d}' fill='none' stroke='black' stroke-width='1.5'/></svg>`,
  )}")`;

/** Masks for `icon: "delete" | "add" | "share"`, read by the plugins through the viewer; `copy`
 * and the other `--psp-icon--*` names are Perspective's own theme icons. */
export const ICON_STYLES = `perspective-viewer{--psp-icon--delete--mask-image:${mask(
  "M4 4l8 8M12 4l-8 8",
)};--psp-icon--add--mask-image:${mask("M8 3v10M3 8h10")};--psp-icon--share--mask-image:${mask(
  "M6 10l4-4 M5 7L3 9a3 3 0 004 4l2-2 M7 5l2-2a3 3 0 014 4l-2 2",
)}}`;
