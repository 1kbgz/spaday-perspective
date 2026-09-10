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

const original = customElements.define.bind(customElements);

customElements.define = (
  name: string,
  ctor: CustomElementConstructor,
  options?: ElementDefinitionOptions,
) => {
  if (!customElements.get(name)) original(name, ctor, options);
};

export function restoreDefine(): void {
  customElements.define = original;
}
