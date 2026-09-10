/** Tolerate another bundle having already registered elements this bundle also registers.
 *
 * This bundle loads upstream libraries that register custom elements at import:
 * the viewer registers `regular-layout` / `regular-layout-frame` / `regular-layout-tab`
 * (Perspective 5's workspace engine) and the datagrid plugin registers `regular-table`.
 * `spaday-regular-layout` and `spaday-regular-table` bundle the same engines — when one
 * of them loads first, the upstream module would throw from `customElements.define` and
 * die, taking the panels with it. Importing this module FIRST makes `define` idempotent
 * (skip names that already exist); `restoreDefine()` puts the real one back once the
 * upstream modules have loaded. They load asynchronously, so until then another script
 * defining a name that already exists is skipped rather than rejected.
 */

const define = customElements.define.bind(customElements);
const lookup = customElements.get.bind(customElements);
// names this bundle registered itself
const ours = new Set<string>();

customElements.define = (
  name: string,
  ctor: CustomElementConstructor,
  options?: ElementDefinitionOptions,
) => {
  if (lookup(name)) return;
  define(name, ctor, options);
  ours.add(name);
};

/** Put the real `define` back, and warn if another copy had already registered any of `tags`, the
 * elements this bundle serves: the page keeps that copy's, which need not match the version this
 * package serves and its catalog describes. `served` names that version, e.g.
 * "@awesome.me/webawesome 3.12.0". A tag that is registered, but not by this bundle, is another
 * copy's -- whether the library skipped it just now or defines its elements later. */
export function restoreDefine(
  served: string,
  tags: readonly string[] = [],
): void {
  customElements.define = define;
  const taken = tags.filter((tag) => lookup(tag) && !ours.has(tag));
  if (!taken.length) return;
  const shown = taken
    .slice(0, 3)
    .map((tag) => `<${tag}>`)
    .join(", ");
  const more = taken.length > 3 ? ` and ${taken.length - 3} more` : "";
  console.warn(
    `${served}: another copy on the page already registered ${shown}${more}; the page keeps that copy's elements, which may not match this version`,
  );
}
