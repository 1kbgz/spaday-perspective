// Validation of the wrapper's own settings. Perspective's — panel configs, layouts, plugin settings,
// themes — are checked by Perspective: `migrate` ahead of time (schema), the viewer when applied.
import type { Validator } from "@perspective-dev/client";

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

function object(value: unknown, path: string): asserts value is Dict {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path}: expected object`);
}
function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${path}: expected string`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function panels(value: unknown, path: string, validator?: Validator): void {
  object(value, path);
  for (const [name, entry] of Object.entries(value)) {
    object(entry, `${path}.${name}`);
    try {
      validator?.validate("panel", { ...entry, table: name });
    } catch (error) {
      throw new TypeError(`${path}.${name}: ${errorMessage(error)}`);
    }
  }
}

export function validateConfig(value: unknown, validator?: Validator): void {
  object(value, "config");
  for (const key of [
    "local",
    "wait_for_table",
    "restore_selected_tabs_only",
    "single_tab",
  ])
    if (key in value && typeof value[key] !== "boolean")
      throw new TypeError(`config.${key}: expected boolean`);
  if (value.ws_url != null) string(value.ws_url, "config.ws_url");
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
      if (typeof table === "string") return string(table, path);
      object(table, path);
      string(table.name, `${path}.name`);
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
    for (const key of ["retained_panel_configs_by_table", "closed_channels"])
      if (layout[key] != null)
        panels(layout[key], `config.${field}.${key}`, validator);
    aliases(
      layout,
      "retained_panel_configs_by_table",
      "closed_channels",
      `config.${field}`,
    );
  }
  for (const field of ["panel_defaults", "channels"])
    if (field in value) panels(value[field], `config.${field}`, validator);
  aliases(value, "workspace", "layout", "config");
  aliases(value, "panel_defaults", "channels", "config");
  aliases(value, "restore_selected_tabs_only", "single_tab", "config");
}
