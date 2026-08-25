/** Tolerate another bundle having already registered elements this bundle also registers.
 *
 * This bundle inlines upstream libraries that register custom elements at import:
 * the viewer registers `regular-layout` / `regular-layout-frame` / `regular-layout-tab`
 * (Perspective 5's workspace engine) and the datagrid plugin registers `regular-table`.
 * `spaday-regular-layout` and `spaday-regular-table` bundle the same engines — when one
 * of them loads first, this bundle would throw from `customElements.define` and die
 * entirely, taking `<perspective-panel>` with it. Importing this module FIRST makes
 * `define` idempotent (skip names that already exist); `restoreDefine()` puts the real
 * one back immediately after the upstream imports, so the guard never leaks to other
 * scripts.
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
