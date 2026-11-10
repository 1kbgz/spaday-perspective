// the guard must execute before the upstream imports register their elements
import { restoreDefine } from "./define-guard.js";
import perspective from "@perspective-dev/client";
import type { GetViewOptions } from "@perspective-dev/viewer";
import PERSPECTIVE_THEMES from "@perspective-dev/viewer/dist/css/themes.css";
import { styleWorkspace } from "./workspace-style.js";
import { installClipboard, type ClipboardViewer } from "./clipboard.js";
import { errorMessage, sameConfig, validateConfig } from "./config.js";
import {
  installRowActions,
  isActionColumn,
  type RowActions,
} from "./row-actions.js";
import { installActionColumns } from "./action-columns.js";
export type { RowAction, RowActions, ActionColumn } from "./row-actions.js";
import {
  migrateConfig,
  pruneLayout,
  tabStacks,
  validator,
  validatorReady,
  type PanelConfig,
  type Workspace,
} from "./workspace.js";

export {
  migrateLayout,
  migrateWorkspace,
  type MigratedWorkspace,
  type MigrateNotice,
} from "./workspace.js";

export type PerspectiveArchitecture = "server" | "client-server";

export interface ShowTableOptions {
  filter?: [string, string, ...unknown[]][];
}

export interface PerspectiveTableConfig {
  name: string;
  architecture?: PerspectiveArchitecture;
  index?: string | string[];
  limit?: number;
}

export interface PerspectiveConfig {
  ws_url?: string;
  local?: boolean;
  tables?: (string | PerspectiveTableConfig)[];
  default_architecture?: PerspectiveArchitecture;
  workspace?: unknown;
  /** Compatibility alias for workspace. */
  layout?: unknown;
  wait_for_table?: boolean;
  panel_defaults?: Record<string, Partial<PanelConfig>>;
  restore_selected_tabs_only?: boolean;
  /** Compatibility alias for panel_defaults. */
  channels?: Record<string, Partial<PanelConfig>>;
  /** Compatibility alias for restore_selected_tabs_only. */
  single_tab?: boolean;
}

type PspClient = Awaited<ReturnType<typeof perspective.websocket>>;
type PspTable = Awaited<ReturnType<PspClient["open_table"]>>;
type PspView = Awaited<ReturnType<PspTable["view"]>>;

declare const __PERSPECTIVE_VERSION__: string;

type Mirror = { view: PspView; table: PspTable };

/* Perspective cannot load twice on a page, so the copy this bundle owns is the page's copy and is
 * shared rather than duplicated: one websocket client per server, one local worker, and one local
 * copy of any mirrored table. Before this, every panel opened its own client and its own worker, so
 * a workspace of four panels on one server paid for four connections and four engines.
 *
 * Sharing reaches other libraries on the page too: their own @perspective-dev imports resolve to
 * this copy through the package's import map, and `__spadayPerspective` (at the bottom of this file)
 * lends them these same clients rather than new ones. */
const remoteClients = new Map<string, Promise<PspClient>>();
let localWorker: Promise<PspClient> | null = null;
const sharedMirrors = new Map<
  string,
  { mirror: Promise<Mirror>; refs: number }
>();

/* The promise is cached, not the resolved client, so concurrent callers share one connection.
 * Both wait on `ready` first: the engine binary has to be instantiated before a client exists, and
 * a caller that skips it gets `Missing perspective-client.wasm`. The panel always awaited it; a
 * borrower reaching for a client directly has no way to, so the registry owns the wait. */
function sharedClient(url: string): Promise<PspClient> {
  const resolved = wsUrl(url);
  const existing = remoteClients.get(resolved);
  if (existing) return existing;
  const created = ready.then(() => perspective.websocket(resolved));
  remoteClients.set(resolved, created);
  return created;
}

function sharedWorker(): Promise<PspClient> {
  localWorker ??= ready.then(() => perspective.worker());
  return localWorker;
}

function mirrorKey(url: string, table: PerspectiveTableConfig): string {
  return JSON.stringify([wsUrl(url), table.name]);
}

/* Perspective folds a one-column list into the column itself, so hints compare that way too. */
function normalizeIndex(
  index: string | string[] | undefined,
): string | string[] | undefined {
  return Array.isArray(index) && index.length === 1 ? index[0] : index;
}

/* A `client-server` table mirrored into the shared worker, refcounted by that key: two panels
 * showing the same mirrored table share one local copy and one update subscription instead of
 * racing to register the same table name in the one worker. Returns the key to release later. */
async function acquireMirror(
  url: string,
  config: PerspectiveTableConfig,
): Promise<string> {
  const key = mirrorKey(url, config);
  const existing = sharedMirrors.get(key);
  if (existing) {
    existing.refs += 1;
    await existing.mirror;
    return key;
  }
  const mirror = (async (): Promise<Mirror> => {
    const [remote, local] = await Promise.all([
      sharedClient(url),
      sharedWorker(),
    ]);
    const serverTable = await remote.open_table(config.name);
    const sourceIndex = normalizeIndex(await serverTable.get_index());
    const view = await serverTable.view();
    const limit = sourceIndex === undefined ? config.limit : undefined;
    if (config.limit !== undefined && limit === undefined)
      console.warn(
        `perspective-panel: ${config.name} mirrors an indexed server table; the configured limit ${config.limit} is ignored`,
      );
    let table: PspTable;
    try {
      // 5.7.0's typings list the data forms only; the runtime accepts a View (`TableData::View`).
      table = await local.table(
        view as unknown as Parameters<PspClient["table"]>[0],
        { name: config.name, index: config.index, limit },
      );
    } catch (error) {
      await view.delete().catch(() => {});
      throw error;
    }
    return { view, table };
  })();
  sharedMirrors.set(key, { mirror, refs: 1 });
  try {
    await mirror;
  } catch (error) {
    sharedMirrors.delete(key); // a failed mirror must not be handed to the next caller
    throw error;
  }
  return key;
}

async function releaseMirror(key: string): Promise<void> {
  const entry = sharedMirrors.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  sharedMirrors.delete(key);
  const mirror = await entry.mirror.catch(() => null);
  if (!mirror) return;
  await mirror.table.delete({ lazy: true }).catch(() => {});
  await mirror.view.delete().catch(() => {});
}

// Perspective's CDN builds initialize themselves from their own URLs. The viewer instantiates the
// client binary with a top-level await and then defines `<perspective-viewer>`, which is where the
// client looks for it; imported statically, that await would hold this module back until the binary
// arrived, and the page would mount its tree before `<perspective-panel>` existed. So the viewer and
// its plugins load dynamically, the panel's work waits on `ready`, and the define-guard stays up
// until they have registered their elements. The client only registers the server binary; it is
// fetched on the first `worker()` call (a `client-server` table architecture), so `server`-only
// pages never pay for it.
const ready = Promise.all([
  import("@perspective-dev/viewer"),
  import("@perspective-dev/viewer-datagrid"),
  import("@perspective-dev/viewer-charts"),
  validatorReady,
])
  .finally(() =>
    restoreDefine(`@perspective-dev/client ${__PERSPECTIVE_VERSION__}`, [
      "perspective-viewer",
      "perspective-viewer-datagrid",
      "perspective-viewer-datagrid-toolbar",
    ]),
  )
  .then(() => customElements.whenDefined("perspective-viewer"));

const THEMES: Record<string, string> = {
  light: "Pro Light",
  dark: "Pro Dark",
};

// Perspective's events do not bubble out of `<perspective-viewer>`; re-dispatch the
// observational set from the panel (bubbling + composed) so spaday's declarative
// `.on("perspective-config-update", ...)` works. The cancelable `-before` events are
// deliberately not re-dispatched — a re-dispatched copy cannot cancel the original.
const REDISPATCH = [
  "perspective-click",
  "perspective-select",
  "perspective-global-filter",
  "perspective-global-filter-update",
  "perspective-config-update",
  "perspective-toggle-settings",
  "perspective-statusbar-pointerdown",
  "perspective-table-delete",
];

let stylesInjected = false;

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = PERSPECTIVE_THEMES.toString();
  document.head.appendChild(style);
}

function wsUrl(url: string): string {
  if (/^wss?:\/\//.test(url)) return url;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${url.startsWith("/") ? "" : "/"}${url}`;
}

// Perspective 5's `<perspective-viewer>` is the multi-panel workspace element
// (the separate `<perspective-workspace>` is gone): `load(client)` binds every
// server table, `restoreWorkspace`/`saveWorkspace` carry the whole-element
// config (the single-panel `restore`/`save` are the per-panel forms). Theme is
// viewer config now, not an attribute; the element auto-sizes, so no manual
// resize plumbing.
type Viewer = ClipboardViewer & {
  getActivePanel(): string | null;
  getViewConfig(options: { panel: string }): Promise<{
    group_by?: string[];
    split_by?: string[];
    expressions?: Record<string, string>;
  }>;
  getTable(options: { panel: string; wait: boolean }): Promise<{
    get_index(): Promise<string | string[] | undefined>;
    get_name(): Promise<string>;
    schema(): Promise<Record<string, string>>;
    view(config: unknown): Promise<{
      to_csv(): Promise<string>;
      to_json(): Promise<unknown>;
      delete(): Promise<unknown>;
    }>;
  }>;
  load(client: unknown): Promise<void>;
  restore(
    config: unknown,
    options?: { panel?: string; wait_for_table?: boolean },
  ): Promise<void>;
  removePanel(id: string): Promise<unknown>;
  restoreWorkspace(
    config: unknown,
    options?: { wait_for_table?: boolean },
  ): Promise<void>;
  saveWorkspace(): Promise<unknown>;
  getView(options: GetViewOptions): Promise<PspView>;
  flush(): Promise<unknown>;
  resetThemes(themes?: string[] | null): Promise<unknown>;
  setAutoSize(autosize: boolean): void;
  setAutoPause(autopause: boolean): Promise<unknown>;
  setThrottle(val?: number | null): void;
  toggleConfig(force?: boolean | null): Promise<unknown>;
};

function migrateConfigured(authored: PerspectiveConfig): Workspace | undefined {
  const field = authored.workspace != null ? "workspace" : "layout";
  const workspace = authored[field];
  return workspace == null
    ? undefined
    : migrateConfig(workspace, `config.${field}`);
}

class PerspectivePanel extends HTMLElement {
  #viewer: Viewer | null = null;
  #config: PerspectiveConfig = {};
  #authoredConfig: PerspectiveConfig = {};
  #connectedUrl: string | null = null;
  #lastWorkspace: string | null = null;
  #workspace: Workspace | undefined;
  #configGeneration = 0;
  #lastSelectedTabsOnly = false;
  #lastMirrored: string | null = null;
  #localLoaded = false;
  #mirrors: string[] = [];
  #loaded = false;
  #unchecked = false;
  #readyFired = false;
  #theme = "Pro Light";
  #explicitTheme = false;
  #modeObserver: MutationObserver | null = null;
  #themes: string[] | null = null;
  #autosize: boolean | null = null;
  #autopause: boolean | null = null;
  #throttle: number | null = null;
  #settings: boolean | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #retainedPanelConfigsByTable = new Map<string, PanelConfig>();
  #clipboard: ReturnType<typeof installClipboard> | null = null;
  #rowActions: RowActions = {};
  #rowActionAdapter: ReturnType<typeof installRowActions> | null = null;
  #actionColumns: ReturnType<typeof installActionColumns> | null = null;

  connectedCallback(): void {
    injectStyles();
    if (!this.#viewer) {
      this.style.display ||= "block";
      this.#viewer = document.createElement("perspective-viewer") as Viewer;
      // the viewer has no intrinsic height; fill the panel, which the embedder sizes
      this.#viewer.style.height = "100%";
      this.appendChild(this.#viewer);
      this.#viewer.addEventListener("perspective-config-update", (event) => {
        // Perspective releases this callback after dispatch; read it synchronously.
        const config = (
          event as CustomEvent<{
            getConfig?: () => PanelConfig & { settings?: boolean };
          }>
        ).detail?.getConfig?.();
        if (config && this.#hasTable(config.table)) {
          // The event carries the element-level config; `settings` is the sidebar state, which a
          // per-panel config may not name (5.7 rejects unknown keys on restore).
          delete config.settings;
          const source = event
            .composedPath()
            .find(
              (node): node is HTMLElement =>
                node instanceof HTMLElement &&
                node.parentElement === this.#viewer &&
                !!node.slot,
            );
          this.#retainedPanelConfigsByTable.set(
            config.table,
            this.#actionColumns?.cleanConfig(config, source?.slot) ??
              structuredClone(config),
          );
        }
      });
      for (const name of REDISPATCH) {
        this.#viewer.addEventListener(name, (event) =>
          this.dispatchEvent(
            new CustomEvent(name, {
              detail: (event as CustomEvent).detail,
              bubbles: true,
              composed: true,
            }),
          ),
        );
      }
    }
    this.#clipboard ??= installClipboard(this, this.#viewer);
    this.#actionColumns ??= installActionColumns(
      this,
      this.#viewer,
      () => this.#rowActions,
      (step) => this.#enqueue(step),
      () => {
        this.#rowActionAdapter?.refresh();
        void this.#enqueue(() => this.#notifyReady()).catch((error) =>
          this.#reportError(error),
        );
      },
    );
    this.#actionColumns.connect();
    this.#rowActionAdapter ??= installRowActions(
      this,
      this.#viewer,
      () => this.#rowActions,
      (panel, header) => this.#actionColumns?.columnKey(panel, header),
    );
    this.#followPageMode();
    this.#apply();
  }

  /** The underlying `<perspective-viewer>` — the escape hatch for its imperative/query
   * API (`getTable`, `download`, `copy`, `getSelection`, agent methods, ...). */
  get viewer(): HTMLElement | null {
    return this.#viewer;
  }

  disconnectedCallback(): void {
    this.#rowActionAdapter?.dispose();
    this.#rowActionAdapter = null;
    this.#actionColumns?.dispose();
    this.#clipboard?.dispose();
    this.#clipboard = null;
    this.#modeObserver?.disconnect();
    this.#modeObserver = null;
  }

  get rowActions(): RowActions {
    return this.#rowActions;
  }
  set rowActions(value: RowActions) {
    if (value != null && (typeof value !== "object" || Array.isArray(value)))
      throw new TypeError("rowActions requires a table-to-column mapping");
    for (const columns of Object.values(value ?? {})) {
      if (!columns || typeof columns !== "object" || Array.isArray(columns))
        throw new TypeError("rowActions requires a table-to-column mapping");
      const headers = new Set<string>();
      for (const [key, entry] of Object.entries(columns)) {
        if (entry && typeof entry === "object" && isActionColumn(entry)) {
          if (
            !key.startsWith("@") ||
            typeof entry.header !== "string" ||
            !entry.header.trim() ||
            !["start", "end"].includes(entry.position) ||
            !Array.isArray(entry.buttons) ||
            headers.has(entry.header)
          )
            throw new TypeError(
              "Action columns require an @ identifier, unique nonempty header, start/end position, and buttons array",
            );
          headers.add(entry.header);
        }
        for (const rule of entry &&
        typeof entry === "object" &&
        isActionColumn(entry)
          ? entry.buttons
          : Array.isArray(entry)
            ? entry
            : [entry]) {
          if (
            !rule ||
            typeof rule.action !== "string" ||
            !rule.action ||
            typeof rule.label !== "string" ||
            !rule.label ||
            (rule.text !== undefined && typeof rule.text !== "string") ||
            (rule.icon !== undefined &&
              !["copy", "delete", "add", "share"].includes(rule.icon))
          )
            throw new TypeError(
              "rowActions requires action and label strings, optional text, and an optional copy/delete/add/share icon",
            );
        }
      }
    }
    this.#rowActions = structuredClone(value ?? {});
    this.#rowActionAdapter?.refresh();
    if (this.#loaded)
      void this.#enqueue(() => this.#actionColumns?.refresh()).catch((error) =>
        this.#reportError(error),
      );
  }

  /** Copy the focused grid selection. Call directly from a user gesture. */
  copySelection(): Promise<boolean> {
    return this.#clipboard?.copySelection() ?? Promise.resolve(false);
  }

  /** Export the configured view without synthetic action value columns. */
  exportData(
    options: { panel?: string; format?: "csv" | "json" } | null = {},
  ): Promise<string> {
    return this.#enqueue(async () => {
      const format = options?.format ?? "csv";
      if (!["csv", "json"].includes(format))
        throw new TypeError("exportData format must be csv or json");
      const viewer = this.#viewer;
      if (!viewer || !this.#loaded)
        throw new Error("Perspective panel is not ready");
      const panel = options?.panel ?? viewer.getActivePanel();
      if (!panel) throw new Error("No active panel to export");
      await viewer.flush();
      const config = await viewer.getViewConfig({ panel });
      const table = await viewer.getTable({ panel, wait: false });
      const view = await table.view(
        this.#actionColumns?.dataConfig(panel, config) ?? config,
      );
      try {
        return format === "csv"
          ? await view.to_csv()
          : JSON.stringify(await view.to_json());
      } finally {
        await view.delete();
      }
    });
  }

  set theme(name: string) {
    this.#explicitTheme = true;
    this.#modeObserver?.disconnect();
    this.#modeObserver = null;
    this.#theme = THEMES[name] ?? name;
    this.#applyTheme();
  }
  get theme(): string {
    return this.#theme;
  }

  // With no explicit `theme`, follow spaday's page-mode convention: the nearest
  // `wa-dark`/`wa-light` ancestor (root class set by `bind_root_class("wa-dark", ...)`)
  // picks Pro Dark / Pro Light, and a MutationObserver tracks class changes live.
  // Setting `theme` at any point takes over permanently.
  #pageMode(): string {
    const scope = this.closest(".wa-dark, .wa-light");
    const dark = scope
      ? scope.classList.contains("wa-dark")
      : document.documentElement.classList.contains("wa-dark");
    return dark ? THEMES.dark : THEMES.light;
  }

  #followPageMode(): void {
    if (this.#explicitTheme || this.#modeObserver) return;
    const apply = () => {
      const next = this.#pageMode();
      if (next !== this.#theme) {
        this.#theme = next;
        this.#applyTheme();
      }
    };
    apply();
    this.#modeObserver = new MutationObserver(apply);
    this.#modeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }

  set config(config: PerspectiveConfig) {
    validateConfig(config ?? {}, validator);
    // until the bundle has Perspective's validator, the schema check waits for `ready` in
    // `#apply` and reports through `perspective-error`
    const unchecked = validator === undefined;
    const workspace = unchecked ? undefined : migrateConfigured(config ?? {});
    this.#authoredConfig = config || {};
    this.#config = {
      ...config,
      workspace: config?.workspace ?? config?.layout,
      panel_defaults: config?.panel_defaults ?? config?.channels,
      restore_selected_tabs_only:
        config?.restore_selected_tabs_only ?? config?.single_tab,
    };
    this.#unchecked = unchecked;
    this.#workspace = workspace;
    this.#apply();
  }
  get config(): PerspectiveConfig {
    return this.#authoredConfig;
  }

  // Element-level options, each a serializable prop queued behind wasm init.
  set themes(names: string[] | null) {
    if (names != null && !Array.isArray(names))
      throw new TypeError("themes: expected array");
    this.#themes = names?.map((name) => THEMES[name] ?? name) ?? null;
    this.#enqueue(() => this.#viewer?.resetThemes(this.#themes));
  }
  get themes(): string[] | null {
    return this.#themes;
  }

  set autosize(autosize: boolean) {
    this.#autosize = !!autosize;
    this.#enqueue(() => this.#viewer?.setAutoSize(this.#autosize!));
  }
  get autosize(): boolean | null {
    return this.#autosize;
  }

  set autopause(autopause: boolean) {
    this.#autopause = !!autopause;
    this.#enqueue(() => this.#viewer?.setAutoPause(this.#autopause!));
  }
  get autopause(): boolean | null {
    return this.#autopause;
  }

  set throttle(val: number | null) {
    this.#throttle = val;
    this.#enqueue(() => this.#viewer?.setThrottle(this.#throttle));
  }
  get throttle(): number | null {
    return this.#throttle;
  }

  set settings(open: boolean) {
    this.#settings = !!open;
    this.#enqueue(() => {
      // skip no-op forced toggles: in Perspective 5.2 they still flip the
      // persisted settings flag + host attribute (see the restoreWorkspace
      // heal in #apply), desyncing the flag from the sidebar
      if (
        !this.#viewer ||
        this.#viewer.hasAttribute("settings") === this.#settings
      ) {
        return;
      }
      return this.#viewer.toggleConfig(this.#settings!);
    });
  }
  get settings(): boolean | null {
    return this.#settings;
  }

  #enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const queued = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        return await step();
      });
    this.#queue = queued;
    return queued;
  }

  // Theme rides viewer config in 5.x; queue it behind wasm init and any
  // in-flight load/restore. Before the first `load` there is nothing to theme —
  // and restore on an empty element creates a deferred table-less panel whose
  // config-update dispatch errors ("Panel has no `table`") — so pre-load themes
  // just park in #theme, which #apply restores after loading.
  #applyTheme(): void {
    if (!this.#loaded) return;
    this.#enqueue(() => this.#restoreTheme());
  }

  // Update each panel once, including inactive tabs.
  async #restoreTheme(): Promise<void> {
    if (!this.#viewer) return;
    const viewer = this.#viewer;
    const ws = (await viewer.saveWorkspace()) as Workspace;
    await Promise.all(
      Object.keys(ws.panels ?? {}).map((id) =>
        viewer.restore({ theme: this.#theme }, { panel: id }),
      ),
    );
  }

  // The application theme replaces saved panel themes before restored plugins render.
  #themedWorkspace(workspace: Workspace): Workspace {
    const cloned = structuredClone(workspace);
    for (const panel of Object.values(cloned.panels ?? {}))
      panel.theme = this.#theme;
    return cloned;
  }

  #hasTable(name: string, config = this.#config): boolean {
    return (
      hasOwn(config.panel_defaults ?? {}, name) ||
      (config.tables ?? []).some(
        (table) => (typeof table === "string" ? table : table.name) === name,
      )
    );
  }

  #rememberPanelConfigs(workspace: Workspace, config = this.#config): void {
    workspace = this.#actionColumns?.clean(workspace) ?? workspace;
    for (const panel of Object.values(workspace.panels ?? {})) {
      if (this.#hasTable(panel.table, config)) {
        this.#retainedPanelConfigsByTable.set(
          panel.table,
          structuredClone(panel),
        );
      }
    }
  }

  // `workspace` is already current: a configured layout is migrated by the `config` setter and a
  // live one is the viewer's own.
  async #restoreWorkspace(
    workspace: Workspace,
    config = this.#config,
  ): Promise<void> {
    if (!this.#viewer) return;
    const prepared = this.#themedWorkspace(workspace);
    for (const [name, cached] of Object.entries(
      prepared.retained_panel_configs_by_table ??
        prepared.closed_channels ??
        {},
    )) {
      if (this.#hasTable(name, config)) {
        this.#retainedPanelConfigsByTable.set(name, structuredClone(cached));
      }
    }
    delete prepared.retained_panel_configs_by_table;
    delete prepared.closed_channels;
    this.#rememberPanelConfigs(prepared, config);
    if (config.restore_selected_tabs_only && prepared.panels) {
      const keep = new Set<string>();
      for (const stack of tabStacks(prepared.layout)) {
        const selected = stack.tabs[stack.selected ?? 0] ?? stack.tabs[0];
        if (selected) keep.add(selected);
      }
      prepared.layout = pruneLayout(prepared.layout, keep);
      prepared.panels = Object.fromEntries(
        Object.entries(prepared.panels).filter(([id]) => keep.has(id)),
      );
      if (prepared.masters)
        prepared.masters = prepared.masters.filter((id) => keep.has(id));
      if (prepared.active && !keep.has(prepared.active)) prepared.active = null;
    }
    // Supplying `panels` replaces every plugin in Perspective 5.6, including
    // hidden tabs. Compare LIVE state so restoring a saved workspace resets user edits.
    // Only complete saved configs on the same tables/plugins can be applied as
    // updates. Plugin/style buckets merge on restore, so changes there must
    // retain replacement semantics too.
    if (
      prepared.panels &&
      Object.keys(prepared.panels).length &&
      !Object.keys(this.#rowActions).length
    ) {
      const live = (await this.#viewer
        .saveWorkspace()
        .catch(() => null)) as Workspace | null;
      if (
        live &&
        live.panels &&
        sameConfig(
          Object.keys(prepared.panels).sort(),
          Object.keys(live.panels).sort(),
        ) &&
        sameConfig(prepared.derived_tables, live.derived_tables) &&
        Object.entries(prepared.panels).every(([id, panel]) => {
          const current = live.panels![id];
          return (
            sameConfig(
              Object.keys(panel).sort(),
              Object.keys(current).sort(),
            ) &&
            (
              [
                "table",
                "plugin",
                "version",
                "plugin_config",
                "columns_config",
              ] as const
            ).every((key) => sameConfig(panel[key], current[key]))
          );
        })
      ) {
        for (const [id, panel] of Object.entries(prepared.panels)) {
          if (!sameConfig(panel, live.panels[id]))
            await this.#viewer.restore(panel, { panel: id });
        }
        delete prepared.panels;
      }
    }
    if (prepared.panels) this.#actionColumns?.reset();
    await this.#viewer.restoreWorkspace(prepared, {
      wait_for_table: !!config.wait_for_table,
    });
    await this.#viewer.flush();
    await this.#actionColumns?.refresh();
    if (
      this.#settings !== true &&
      !prepared.active &&
      this.#viewer.hasAttribute("settings")
    ) {
      await this.#viewer.toggleConfig();
    }
  }

  /** Open or select a table panel using its retained configuration or defaults. */
  openTablePanel(name: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#hasTable(name)) throw new Error(`Unknown table: ${name}`);
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      this.#rememberPanelConfigs(workspace);
      const existing = Object.entries(workspace.panels ?? {}).find(
        ([, panel]) => panel.table === name,
      )?.[0];
      if (existing) {
        for (const stack of tabStacks(workspace.layout)) {
          if (stack.tabs.includes(existing))
            stack.selected = stack.tabs.indexOf(existing);
        }
        await this.#viewer.restoreWorkspace({ layout: workspace.layout });
        return;
      }
      const panels = (workspace.panels ??= {});
      let id = `channel:${name}`;
      while (hasOwn(panels, id)) id += ":";
      panels[id] = structuredClone(
        this.#retainedPanelConfigsByTable.get(name) ?? {
          ...(hasOwn(this.#config.panel_defaults ?? {}, name)
            ? this.#config.panel_defaults![name]
            : { plugin: "Datagrid" }),
          table: name,
        },
      );
      const stack = tabStacks(workspace.layout).find((tabs) =>
        tabs.tabs.some((tab) => !workspace.masters?.includes(tab)),
      );
      if (stack) {
        stack.tabs.push(id);
        stack.selected = stack.tabs.length - 1;
      } else if (workspace.layout && tabStacks(workspace.layout).length) {
        workspace.layout = {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [0.25, 0.75],
          children: [workspace.layout, { type: "tab-layout", tabs: [id] }],
        };
      } else {
        // an emptied workspace reports a split with no children; start from the new tab instead
        workspace.layout = { type: "tab-layout", tabs: [id] };
      }
      await this.#restoreWorkspace(workspace);
    });
  }

  /** Select a detail panel and replace filters on the supplied columns. */
  async showTable(
    name: string,
    options: ShowTableOptions = {},
  ): Promise<string> {
    const patch = structuredClone(options);
    return this.#enqueue(async () => {
      if (!this.#hasTable(name)) throw new Error(`Unknown table: ${name}`);
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new TypeError("options: expected object");
      if (
        patch.filter !== undefined &&
        (!Array.isArray(patch.filter) ||
          patch.filter.some(
            (clause) =>
              !Array.isArray(clause) ||
              clause.length < 2 ||
              typeof clause[0] !== "string" ||
              typeof clause[1] !== "string",
          ))
      )
        throw new TypeError("options.filter: expected filter clauses");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      const panels = workspace.panels ?? {};
      let id = Object.keys(panels).find(
        (id) => panels[id].table === name && !workspace.masters?.includes(id),
      );
      const existing = id !== undefined;
      if (!id) {
        id = `channel:${name}`;
        while (hasOwn(panels, id)) id += ":";
      }
      const config = existing
        ? panels[id]
        : {
            plugin: "Datagrid",
            ...(hasOwn(this.#config.panel_defaults ?? {}, name)
              ? structuredClone(this.#config.panel_defaults![name])
              : {}),
            table: name,
            theme: this.#theme,
          };
      const update: Partial<PanelConfig> = existing ? {} : config;
      if (patch.filter?.length) {
        const columns = new Set(patch.filter.map((clause) => clause[0]));
        // a clause's term may be omitted; the declared `Filter` tuple does not say so
        update.filter = [
          ...(config.filter ?? []).filter((clause) => !columns.has(clause[0])),
          ...patch.filter,
        ] as PanelConfig["filter"];
      }
      if (Object.keys(update).length) {
        try {
          await this.#viewer.restore(update, {
            panel: id,
            wait_for_table: this.#config.wait_for_table,
          });
        } catch (error) {
          if (!existing) await this.#viewer.removePanel(id);
          throw error;
        }
      }
      // Finish the initial panel render before restoring its tab placement.
      await this.#viewer.flush();
      let stack = tabStacks(workspace.layout).find((stack) =>
        stack.tabs.includes(id),
      );
      if (!stack) {
        stack = tabStacks(workspace.layout).find((stack) =>
          stack.tabs.some((tab) => !workspace.masters?.includes(tab)),
        );
        if (stack) stack.tabs.push(id);
        else {
          stack = { type: "tab-layout", tabs: [id] };
          // an emptied workspace reports a split with no children; replace it
          workspace.layout =
            workspace.layout && tabStacks(workspace.layout).length
              ? {
                  type: "split-layout",
                  orientation: "horizontal",
                  sizes: [1, 3],
                  children: [workspace.layout, stack],
                }
              : stack;
        }
      }
      stack.selected = stack.tabs.indexOf(id);
      await this.#viewer.restoreWorkspace({
        layout: workspace.layout,
      });
      await this.#viewer.flush();
      await this.#actionColumns?.refresh();
      this.#rememberPanelConfigs(
        (await this.#viewer.saveWorkspace()) as Workspace,
      );
      return id;
    });
  }

  /** Close every panel for a table, retaining the last configuration for reopening. */
  closeTablePanels(name: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#hasTable(name)) throw new Error(`Unknown table: ${name}`);
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      this.#rememberPanelConfigs(workspace);
      const panels = Object.fromEntries(
        Object.entries(workspace.panels ?? {}).filter(
          ([, panel]) => panel.table !== name,
        ),
      );
      const keep = new Set(Object.keys(panels));
      workspace.panels = panels;
      workspace.layout = pruneLayout(workspace.layout, keep);
      if (workspace.masters)
        workspace.masters = workspace.masters.filter((id) => keep.has(id));
      if (workspace.active && !keep.has(workspace.active))
        workspace.active = null;
      await this.#restoreWorkspace(workspace);
    });
  }

  /** Compatibility alias for openTablePanel(). */
  openChannel(name: string): Promise<void> {
    return this.openTablePanel(name);
  }

  /** Compatibility alias for closeTablePanels(). */
  closeChannel(name: string): Promise<void> {
    return this.closeTablePanels(name);
  }

  /** Apply a partial viewer configuration to one panel through the lifecycle queue. */
  async restorePanel(id: string, config: Partial<PanelConfig>): Promise<void> {
    const patch = structuredClone(config);
    return this.#enqueue(async () => {
      try {
        validator?.validate("viewer", patch);
      } catch (error) {
        throw new TypeError(`config: ${errorMessage(error)}`);
      }
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      if (!hasOwn(workspace.panels ?? {}, id))
        throw new Error(`Unknown panel: ${id}`);
      await this.#viewer.restore(patch, { panel: id });
      await this.#viewer.flush();
      await this.#actionColumns?.refresh();
      this.#rememberPanelConfigs(
        (await this.#viewer.saveWorkspace()) as Workspace,
      );
    });
  }

  #reportError(error: unknown): void {
    this.dispatchEvent(
      new CustomEvent("perspective-error", {
        detail: error,
        bubbles: true,
        composed: true,
      }),
    );
  }

  // `client-server` tables mirror into a local worker: open the server table, take a
  // view, and replicate it (indexed sources) or refresh a local snapshot from it on changes.
  // `viewer.load` ACCUMULATES clients and resolves panel table names
  // across all of them in load order, so the worker is loaded before the websocket
  // client — the local copies win the name lookup. `server` tables (the default) resolve
  // from the websocket client as before.
  #mirroredTables(config: PerspectiveConfig): PerspectiveTableConfig[] {
    if (!config.ws_url) return [];
    return (config.tables ?? [])
      .map((t) => (typeof t === "string" ? { name: t } : t))
      .filter(
        (t) =>
          (t.architecture ?? config.default_architecture ?? "server") ===
          "client-server",
      );
  }

  async #teardownMirrors(): Promise<void> {
    for (const key of this.#mirrors.splice(0)) await releaseMirror(key);
  }

  #apply(): void {
    const config = this.#config;
    const generation = ++this.#configGeneration;
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        if (!this.#viewer || generation !== this.#configGeneration) return;
        styleWorkspace(this.#viewer);
        try {
          if (this.#unchecked) {
            validateConfig(this.#authoredConfig, validator);
            this.#workspace = migrateConfigured(this.#authoredConfig);
            this.#unchecked = false;
          }
          const mirrored = this.#mirroredTables(config);
          const mirroredKey = JSON.stringify(mirrored);
          if (
            config.ws_url &&
            (config.ws_url !== this.#connectedUrl ||
              mirroredKey !== this.#lastMirrored)
          ) {
            this.#connectedUrl = config.ws_url;
            this.#lastMirrored = mirroredKey;
            await this.#teardownMirrors();
            const remote = await sharedClient(config.ws_url);
            if (mirrored.length) {
              const local = await sharedWorker();
              for (const t of mirrored) {
                this.#mirrors.push(await acquireMirror(config.ws_url, t));
              }
              if (!this.#localLoaded) {
                this.#localLoaded = true;
                await this.#viewer.load(local);
              }
            }
            await this.#viewer.load(remote);
            this.#loaded = true;
          }
          if (config.local && !this.#localLoaded) {
            this.#localLoaded = true;
            await this.#viewer.load(await sharedWorker());
            this.#loaded = true;
          }
          if (generation !== this.#configGeneration) return;
          if (this.#loaded && this.#workspace) {
            const workspace = JSON.stringify(config.workspace);
            if (workspace !== this.#lastWorkspace) {
              // Perspective 5.5 errors on a `table` no loaded client hosts; `wait_for_table`
              // restores the earlier behavior, a pending panel that fills once it is created
              this.#retainedPanelConfigsByTable.clear();
              this.#lastWorkspace = null;
              await this.#restoreWorkspace(this.#workspace, config);
              this.#lastWorkspace = workspace;
            } else if (
              !!config.restore_selected_tabs_only !== this.#lastSelectedTabsOnly
            ) {
              await this.#restoreWorkspace(
                (await this.#viewer.saveWorkspace()) as Workspace,
                config,
              );
            }
          }
          if (generation !== this.#configGeneration) return;
          this.#lastSelectedTabsOnly = !!config.restore_selected_tabs_only;
          // one-shot readiness: connected, tables loaded, and the initial workspace
          // config (when the config carries one) applied and rendered — the stable
          // signal a branded startup overlay can key off, unlike
          // perspective-config-update, which describes config changes and never
          // fires when initialization fails
          await this.#notifyReady();
        } catch (error) {
          // surface (don't swallow) apply failures; the queue itself stays alive,
          // and hosts can swap a loader for an error state
          console.error("perspective-panel: config apply failed", error);
          this.dispatchEvent(
            new CustomEvent("perspective-error", {
              detail: error,
              bubbles: true,
              composed: true,
            }),
          );
          throw error;
        }
      });
  }

  async #notifyReady(): Promise<void> {
    if (
      this.#readyFired ||
      !this.isConnected ||
      !this.#loaded ||
      !this.#viewer ||
      (this.#config.workspace && this.#lastWorkspace === null) ||
      this.#actionColumns?.isValid() === false
    )
      return;
    await this.#viewer.flush();
    if (
      this.#readyFired ||
      !this.isConnected ||
      this.#actionColumns?.isValid() === false
    )
      return;
    this.#readyFired = true;
    this.dispatchEvent(
      new CustomEvent("perspective-ready", { bubbles: true, composed: true }),
    );
  }

  /** The whole-element workspace config (layout tree + per-panel viewer configs). */
  async saveWorkspace(): Promise<unknown> {
    await this.#queue.catch(() => {});
    await this.#actionColumns?.refresh();
    const workspace = (await this.#viewer?.saveWorkspace()) as
      | Workspace
      | undefined;
    if (!workspace) return workspace;
    const clean = this.#actionColumns?.clean(workspace) ?? workspace;
    this.#rememberPanelConfigs(clean);
    const open = new Set(
      Object.values(clean.panels ?? {}).map((panel) => panel.table),
    );
    const closed = Object.fromEntries(
      [...this.#retainedPanelConfigsByTable].filter(
        ([name]) => this.#hasTable(name) && !open.has(name),
      ),
    );
    if (Object.keys(closed).length)
      clean.retained_panel_configs_by_table = structuredClone(closed);
    return clean;
  }

  /** Compatibility workspace save using the historical closed_channels metadata key. */
  async save(): Promise<unknown> {
    const workspace = (await this.saveWorkspace()) as Workspace | undefined;
    if (workspace?.retained_panel_configs_by_table) {
      workspace.closed_channels = workspace.retained_panel_configs_by_table;
      delete workspace.retained_panel_configs_by_table;
    }
    return workspace;
  }

  /** Compatibility alias for `saveWorkspace()`. */
  savePortableWorkspace(): Promise<unknown> {
    return this.saveWorkspace();
  }

  /** Compatibility alias for `save()`. */
  saveClean(): Promise<unknown> {
    return this.save();
  }
}

if (!customElements.get("perspective-panel")) {
  customElements.define("perspective-panel", PerspectivePanel);
}

/* Lend the page's one Perspective engine to any other library on the page.
 *
 * Perspective registers global custom element names, so a second copy on the page throws from
 * `customElements.define` and the two engines cannot coexist. A library that accepts an injected
 * client can skip its own `@perspective-dev` imports entirely, which is what avoids the second copy
 * -- but it needs a client to inject, and this bundle previously exported nothing to the page.
 *
 * `client(url)` hands back the same websocket client `<perspective-panel>` uses for that server and
 * `worker()` the same local engine, not new ones. Both stay lazy, so a page using only the borrower
 * never starts an engine it does not need, and neither does a page using only the panel.
 *
 * `version` is the Perspective version actually bundled here: a consumer resolving its own
 * `^5.3.0` can end up a patch ahead, so it should compare and refuse rather than half-work. */
Object.defineProperty(globalThis, "__spadayPerspective", {
  value: Object.freeze({
    version: __PERSPECTIVE_VERSION__,
    client: (url: string): Promise<PspClient> => sharedClient(url),
    worker: (): Promise<PspClient> => sharedWorker(),
  }),
  configurable: true,
  enumerable: false,
  writable: false,
});

export { PerspectivePanel };
