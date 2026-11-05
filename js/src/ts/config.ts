// Validation of the wrapper's own configuration. Everything Perspective owns — a panel's viewer
// config, table `index`/`limit` options, layout trees — is left to Perspective, which rejects bad
// shapes itself (`restore` goes through serde; the engine raises `BadTableOptions`). The one gap is
// a plugin's `plugin_config`: the viewer stores it as an opaque map and the Datagrid coerces what it
// reads, silently dropping a misspelled `edit_mode` or a string `scroll_lock`. `validatePluginConfig`
// closes that gap at runtime against the plugin's own `plugin_config_schema`.

type Dict = Record<string, unknown>;
export function sameConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Dict;
  const right = b as Dict;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameConfig(left[key], right[key]),
    )
  );
}

function aliases(value: Dict, canonical: string, legacy: string, path: string) {
  if (
    canonical in value &&
    legacy in value &&
    !sameConfig(value[canonical], value[legacy])
  )
    throw new TypeError(
      `${path}.${canonical}: conflicts with ${path}.${legacy}`,
    );
}

export function object(value: unknown, path: string): asserts value is Dict {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path}: expected object`);
}
export function validateTheme(
  value: unknown,
  path = "theme",
): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${path}: expected string`);
}

/** A mapping the wrapper walks itself: `panels`, `channels`, and the like. */
function panels(value: unknown, path: string): void {
  object(value, path);
  for (const [name, entry] of Object.entries(value))
    object(entry, `${path}.${name}`);
}

export function validateConfig(value: unknown): void {
  object(value, "config");
  for (const key of [
    "local",
    "wait_for_table",
    "restore_selected_tabs_only",
    "single_tab",
  ])
    if (key in value && typeof value[key] !== "boolean")
      throw new TypeError(`config.${key}: expected boolean`);
  for (const key of ["ws_url", "master_theme"])
    if (value[key] != null) validateTheme(value[key], `config.${key}`);
  if (
    "default_architecture" in value &&
    !["server", "client-server"].includes(value.default_architecture as string)
  )
    throw new TypeError(
      "config.default_architecture: expected server or client-server",
    );
  if ("tables" in value) {
    if (!Array.isArray(value.tables))
      throw new TypeError("config.tables: expected array");
    value.tables.forEach((table, i) => {
      const path = `config.tables[${i}]`;
      if (typeof table === "string") return validateTheme(table, path);
      object(table, path);
      validateTheme(table.name, `${path}.name`);
      if (
        "architecture" in table &&
        !["server", "client-server"].includes(table.architecture as string)
      )
        throw new TypeError(
          `${path}.architecture: expected server or client-server`,
        );
    });
  }
  for (const field of ["workspace", "layout"]) {
    if (value[field] == null) continue;
    let layout = value[field];
    if (typeof layout === "string") {
      try {
        layout = JSON.parse(layout);
      } catch {
        throw new TypeError(`config.${field}: invalid JSON`);
      }
    }
    object(layout, `config.${field}`);
    for (const key of [
      "panels",
      "viewers",
      "retained_panel_configs_by_table",
      "closed_channels",
    ])
      if (layout[key] != null) panels(layout[key], `config.${field}.${key}`);
    aliases(
      layout,
      "retained_panel_configs_by_table",
      "closed_channels",
      `config.${field}`,
    );
  }
  for (const field of ["panel_defaults", "channels"])
    if (field in value) panels(value[field], `config.${field}`);
  aliases(value, "workspace", "layout", "config");
  aliases(value, "panel_defaults", "channels", "config");
  aliases(value, "restore_selected_tabs_only", "single_tab", "config");
}

/** A plugin custom element, as `viewer.getAllPlugins()` returns them. */
export interface PluginElement {
  name: string;
  plugin_config_schema?(
    view_config?: Record<string, unknown>,
    current_value?: Record<string, unknown> | null,
  ): { fields: SchemaField[] };
}
type SchemaField = Record<string, unknown> & { kind: string; key?: string };
type Rule =
  | { kind: "enum"; values: unknown[] }
  | { kind: "boolean" | "string" | "any" }
  | { kind: "number"; min?: number };

// The nine cells of the viewer's `Alignment` control (`Alignment::ALL` upstream), which the schema
// does not enumerate at runtime. `config.spec.js` checks them against the Datagrid's `Align` type.
export const ALIGNMENTS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
const CORNERS = ALIGNMENTS.filter((cell) => cell.includes("-"));

function rules(fields: SchemaField[], into = new Map<string, Rule>()) {
  for (const field of fields) {
    const key = field.key as string;
    switch (field.kind) {
      case "Group":
        rules(field.fields as SchemaField[], into);
        break;
      case "Font": {
        into.set(key, { kind: "string" });
        const size = field.size as (SchemaField & { min?: number }) | undefined;
        if (size) into.set(size.key!, { kind: "number", min: size.min });
        for (const toggle of [field.bold, field.italic] as (
          | SchemaField
          | undefined
        )[])
          if (toggle) into.set(toggle.key!, { kind: "boolean" });
        break;
      }
      case "Alignment":
        into.set(key, {
          kind: "enum",
          values: field.corners ? CORNERS : [...ALIGNMENTS],
        });
        break;
      case "Enum":
        into.set(key, {
          kind: "enum",
          values: (field.variants as { value: unknown }[]).map((v) => v.value),
        });
        break;
      case "Bool":
        into.set(key, { kind: "boolean" });
        break;
      case "Number":
        into.set(key, { kind: "number", min: field.min as number | undefined });
        break;
      case "Color":
        into.set(key, { kind: "string" });
        break;
      default:
        // a control kind newer than this wrapper: the key exists, its domain is unknown
        into.set(key, { kind: "any" });
    }
  }
  return into;
}

/**
 * Check `config` against the settings `plugin` advertises for it. A plugin without a
 * `plugin_config_schema` describes no settings and is left alone. The schema's `min` is enforced
 * because the Datagrid drops values below it (a zero or negative size) without a word; `max` is a
 * slider bound and is not.
 */
export function validatePluginConfig(
  plugin: PluginElement,
  config: unknown,
  path: string,
): void {
  object(config, path);
  const schema = plugin.plugin_config_schema?.(undefined, config);
  if (!schema) return;
  const known = rules(schema.fields);
  for (const [key, value] of Object.entries(config)) {
    const target = `${path}.${key}`;
    const rule = known.get(key);
    if (!rule) throw new TypeError(`${target}: not a ${plugin.name} setting`);
    switch (rule.kind) {
      case "any":
        break;
      case "enum":
        if (!rule.values.includes(value))
          throw new TypeError(
            `${target}: expected one of ${rule.values.join(", ")}`,
          );
        break;
      case "string":
        validateTheme(value, target);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new TypeError(`${target}: expected number`);
        if (rule.min !== undefined && value < rule.min)
          throw new TypeError(`${target}: expected number >= ${rule.min}`);
        break;
      default:
        if (typeof value !== rule.kind)
          throw new TypeError(`${target}: expected ${rule.kind}`);
    }
  }
}
