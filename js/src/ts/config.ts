import rules from "../../../spaday_perspective/config-contract.json";

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
export function validateTheme(
  value: unknown,
  path = "theme",
): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${path}: expected string`);
}
export function validatePanel(
  value: unknown,
  path: string,
  plugin: unknown = "Datagrid",
) {
  object(value, path);
  for (const key of ["table", "plugin", "theme"])
    if (value[key] != null) validateTheme(value[key], `${path}.${key}`);
  if (value.plugin_config == null || (value.plugin ?? plugin) !== "Datagrid")
    return;
  const config = value.plugin_config;
  object(config, `${path}.plugin_config`);
  const settings: Record<string, { kind: string; values?: string[] }> = {
    ...rules,
    editable: { kind: "boolean" },
    columns: { kind: "object" },
  };
  for (const [key, setting] of Object.entries(config)) {
    const target = `${path}.plugin_config.${key}`;
    const rule = Object.prototype.hasOwnProperty.call(settings, key)
      ? settings[key]
      : undefined;
    if (!rule) throw new TypeError(`${target}: unknown Datagrid setting`);
    if (rule.kind === "enum") {
      if (!rule.values!.includes(setting as string))
        throw new TypeError(
          `${target}: expected one of ${rule.values!.join(", ")}`,
        );
    } else if (rule.kind === "object") object(setting, target);
    else if (rule.kind === "string") validateTheme(setting, target);
    else if (
      typeof setting !== rule.kind ||
      (rule.kind === "number" && !Number.isFinite(setting))
    )
      throw new TypeError(`${target}: expected ${rule.kind}`);
    if (
      rule.kind === "number" &&
      (key === "zebra_rows"
        ? (setting as number) < 0
        : (setting as number) <= 0)
    )
      throw new TypeError(
        `${target}: expected ${key === "zebra_rows" ? "nonnegative" : "positive"} number`,
      );
  }
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
      if ("index" in table) {
        if (Array.isArray(table.index)) {
          table.index.forEach((column, j) =>
            validateTheme(column, `${path}.index[${j}]`),
          );
        } else validateTheme(table.index, `${path}.index`);
      }
      if (
        "limit" in table &&
        (!Number.isInteger(table.limit) || (table.limit as number) <= 0)
      )
        throw new TypeError(`${path}.limit: expected positive integer`);
      if ("index" in table && "limit" in table)
        throw new TypeError(`${path}: index and limit are mutually exclusive`);
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
    ]) {
      const entries = layout[key];
      if (entries == null) continue;
      object(entries, `config.${field}.${key}`);
      for (const [name, entry] of Object.entries(entries))
        validatePanel(entry, `config.${field}.${key}.${name}`);
    }
    aliases(
      layout,
      "retained_panel_configs_by_table",
      "closed_channels",
      `config.${field}`,
    );
  }
  for (const field of ["panel_defaults", "channels"]) {
    if (!(field in value)) continue;
    object(value[field], `config.${field}`);
    for (const [name, entry] of Object.entries(value[field]))
      validatePanel(entry, `config.${field}.${name}`);
  }
  aliases(value, "workspace", "layout", "config");
  aliases(value, "panel_defaults", "channels", "config");
  aliases(value, "restore_selected_tabs_only", "single_tab", "config");
}
