import rules from "../../../spaday_perspective/config-contract.json";

type Dict = Record<string, unknown>;
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
function panel(value: unknown, path: string) {
  object(value, path);
  for (const key of ["table", "plugin", "theme"])
    if (value[key] != null) validateTheme(value[key], `${path}.${key}`);
  if (
    value.plugin_config == null ||
    (value.plugin ?? "Datagrid") !== "Datagrid"
  )
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
  for (const key of ["local", "wait_for_table", "single_tab"])
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
      if ("index" in table) validateTheme(table.index, `${path}.index`);
      if (
        "limit" in table &&
        (!Number.isInteger(table.limit) || (table.limit as number) <= 0)
      )
        throw new TypeError(`${path}.limit: expected positive integer`);
      if ("index" in table && "limit" in table)
        throw new TypeError(`${path}: index and limit are mutually exclusive`);
    });
  }
  if (value.layout != null) {
    let layout = value.layout;
    if (typeof layout === "string") {
      try {
        layout = JSON.parse(layout);
      } catch {
        throw new TypeError("config.layout: invalid JSON");
      }
    }
    object(layout, "config.layout");
    for (const key of ["panels", "viewers", "closed_channels"]) {
      const entries = layout[key];
      if (entries == null) continue;
      object(entries, `config.layout.${key}`);
      for (const [name, entry] of Object.entries(entries))
        panel(entry, `config.layout.${key}.${name}`);
    }
  }
  if ("channels" in value) {
    object(value.channels, "config.channels");
    for (const [name, entry] of Object.entries(value.channels))
      panel(entry, `config.channels.${name}`);
  }
}
