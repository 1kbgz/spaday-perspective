// the guard must execute before the upstream imports register their elements
import { restoreDefine } from "./define-guard.js";
import perspective from "@perspective-dev/client";
import PRO from "@perspective-dev/viewer/dist/css/pro.css";
import PRO_DARK from "@perspective-dev/viewer/dist/css/pro-dark.css";
import { installClipboard, type ClipboardViewer } from "./clipboard.js";
import { validateConfig, validateTheme } from "./config.js";
import { installFind, type FindViewer } from "./find.js";
import {
  installRowActions,
  isActionColumn,
  type RowActions,
} from "./row-actions.js";
import { installActionColumns } from "./action-columns.js";
export type { RowAction, RowActions, ActionColumn } from "./row-actions.js";
import {
  migrateLayout,
  pruneLayout,
  tabStacks,
  type PanelConfig,
  type Workspace,
} from "./workspace.js";

export { migrateLayout } from "./workspace.js";

export type PerspectiveArchitecture = "server" | "client-server";

export interface PerspectiveTableConfig {
  name: string;
  architecture?: PerspectiveArchitecture;
  index?: string;
  limit?: number;
}

export interface PerspectiveConfig {
  ws_url?: string;
  local?: boolean;
  tables?: (string | PerspectiveTableConfig)[];
  default_architecture?: PerspectiveArchitecture;
  layout?: unknown;
  wait_for_table?: boolean;
  master_theme?: string;
  channels?: Record<string, Partial<PanelConfig>>;
  single_tab?: boolean;
}

type PspClient = Awaited<ReturnType<typeof perspective.websocket>>;
type PspTable = Awaited<ReturnType<PspClient["open_table"]>>;
type PspView = Awaited<ReturnType<PspTable["view"]>>;

declare const __PERSPECTIVE_VERSION__: string;

type Mirror = { view: PspView; table: PspTable; stop(): Promise<void> };

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
  return JSON.stringify([
    wsUrl(url),
    table.name,
    table.index ?? null,
    table.limit ?? null,
  ]);
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
    const view = await serverTable.view();
    const table = await local.table(await serverTable.schema(), {
      name: config.name,
      index:
        config.index ??
        (config.limit === undefined
          ? (await serverTable.get_index()) || undefined
          : undefined),
      limit: config.limit,
    });
    let stopped = false;
    let dirty = false;
    let running: Promise<void> | undefined;
    const report = (error: unknown) =>
      console.error("perspective-panel: mirror refresh failed", error);
    const refresh = (): Promise<void> => {
      dirty = true;
      running ??= (async () => {
        dirty = false;
        // Row deltas omit deleted keys. Replace from an authoritative snapshot, also
        // covering clear/replace and unindexed sources without appending duplicates.
        const snapshot = await view.to_arrow();
        if (!stopped) await table.replace(snapshot);
      })().finally(() => {
        running = undefined;
        // Ready means the first snapshot is loaded, not that a live source is idle.
        if (dirty && !stopped) void refresh().catch(report);
      });
      return running;
    };
    // Subscribe before the initial snapshot so writes during initialization are not lost.
    const subscription = await view.on_update(() => {
      void refresh().catch(report);
    });
    const stop = async () => {
      stopped = true;
      await view.remove_update(subscription);
      await running?.catch(() => {});
    };
    try {
      await refresh();
    } catch (error) {
      await stop();
      await view.delete();
      await table.delete({ lazy: true });
      throw error;
    }
    return { view, table, stop };
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
  await mirror.stop().catch(() => {});
  await mirror.view.delete().catch(() => {});
  await mirror.table.delete({ lazy: true }).catch(() => {});
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
  style.textContent = [
    PRO,
    PRO_DARK,
    `
    perspective-panel[hide-tabs] > perspective-viewer {
      --psp-panel-titlebar--height: 0px;
    }
    perspective-panel[hide-tabs] > perspective-viewer > perspective-viewer-tab {
      display: none !important;
    }
  `,
  ].join("\n");
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
type Viewer = ClipboardViewer &
  Omit<FindViewer, "getTable"> & {
    getViewConfig(options: { panel: string }): Promise<{
      group_by?: string[];
      split_by?: string[];
      expressions?: Record<string, string>;
    }>;
    getTable(options: { panel: string; wait: boolean }): Promise<{
      get_index(): Promise<string>;
      get_name(): Promise<string>;
      schema(): Promise<Record<string, string>>;
      view(config: unknown): Promise<{
        to_csv(): Promise<string>;
        to_json(): Promise<unknown>;
        delete(): Promise<unknown>;
      }>;
    }>;
    load(client: unknown): Promise<void>;
    restore(config: unknown, options?: { panel?: string }): Promise<void>;
    restoreWorkspace(
      config: unknown,
      options?: { wait_for_table?: boolean },
    ): Promise<void>;
    saveWorkspace(): Promise<unknown>;
    flush(): Promise<unknown>;
    resetThemes(themes?: string[] | null): Promise<unknown>;
    setAutoSize(autosize: boolean): void;
    setAutoPause(autopause: boolean): Promise<unknown>;
    setThrottle(val?: number | null): void;
    toggleConfig(force?: boolean | null): Promise<unknown>;
  };

class PerspectivePanel extends HTMLElement {
  #viewer: Viewer | null = null;
  #config: PerspectiveConfig = {};
  #connectedUrl: string | null = null;
  #lastLayout: string | null = null;
  #lastMasterTheme: string | undefined;
  #lastSingleTab = false;
  #lastMirrored: string | null = null;
  #localLoaded = false;
  #mirrors: string[] = [];
  #loaded = false;
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
  #channelConfigs = new Map<string, PanelConfig>();
  #toolbar = false;
  #titlebar: HTMLElement | null = null;
  #toolbarResize: ResizeObserver | null = null;
  #toolbarKey: string | null = null;
  #clipboard: ReturnType<typeof installClipboard> | null = null;
  #rowActions: RowActions = {};
  #rowActionAdapter: ReturnType<typeof installRowActions> | null = null;
  #actionColumns: ReturnType<typeof installActionColumns> | null = null;
  #find = false;
  #findAdapter: ReturnType<typeof installFind> | null = null;

  connectedCallback(): void {
    injectStyles();
    if (!this.#viewer) {
      this.style.display ||= "block";
      this.#viewer = document.createElement("perspective-viewer") as Viewer;
      // the viewer has no intrinsic height; fill the panel, which the embedder sizes
      this.#viewer.style.height = "100%";
      this.appendChild(this.#viewer);
      this.#viewer.addEventListener("perspective-config-update", (event) => {
        if (!this.#config.channels) return;
        // Perspective releases this callback after dispatch; read it synchronously.
        const config = (
          event as CustomEvent<{ getConfig?: () => PanelConfig }>
        ).detail?.getConfig?.();
        if (config && hasOwn(this.#config.channels ?? {}, config.table)) {
          const source = event
            .composedPath()
            .find(
              (node): node is HTMLElement =>
                node instanceof HTMLElement &&
                node.parentElement === this.#viewer &&
                !!node.slot,
            );
          this.#channelConfigs.set(
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
    this.#findAdapter ??= installFind(this, this.#viewer, () => this.#find);
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
    this.#renderToolbar();
    if (this.#titlebar) this.#toolbarResize?.observe(this.#titlebar);
    this.#apply();
  }

  /** The underlying `<perspective-viewer>` — the escape hatch for its imperative/query
   * API (`getTable`, `download`, `copy`, `getSelection`, agent methods, ...). */
  get viewer(): HTMLElement | null {
    return this.#viewer;
  }

  disconnectedCallback(): void {
    this.#toolbarResize?.disconnect();
    this.#findAdapter?.dispose();
    this.#findAdapter = null;
    this.#rowActionAdapter?.dispose();
    this.#rowActionAdapter = null;
    this.#actionColumns?.dispose();
    this.#clipboard?.dispose();
    this.#clipboard = null;
    this.#modeObserver?.disconnect();
    this.#modeObserver = null;
  }

  get hideTabs(): boolean {
    return this.hasAttribute("hide-tabs");
  }
  set hideTabs(value: boolean) {
    this.toggleAttribute("hide-tabs", !!value);
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
              !["copy", "delete", "add"].includes(rule.icon))
          )
            throw new TypeError(
              "rowActions requires action and label strings, optional text, and an optional copy/delete/add icon",
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
    validateTheme(name);
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
    validateConfig(config ?? {});
    this.#config = config || {};
    this.#apply();
  }
  get config(): PerspectiveConfig {
    return this.#config;
  }

  get find(): boolean {
    return this.#find;
  }
  set find(enabled: boolean) {
    if (typeof enabled !== "boolean")
      throw new TypeError("find: expected boolean");
    this.#find = enabled;
    if (!enabled) this.#findAdapter?.cancel();
    this.#renderToolbar();
  }
  openFind(): Promise<void> {
    return this.#findAdapter?.open() ?? Promise.resolve();
  }

  set toolbar(visible: boolean) {
    this.#toolbar = !!visible;
    this.#renderToolbar();
  }
  get toolbar(): boolean {
    return this.#toolbar;
  }

  #renderToolbar(): void {
    if (!this.#viewer) return;
    const key = JSON.stringify([
      this.#toolbar,
      this.#find,
      this.#config.channels,
    ]);
    if (key === this.#toolbarKey) return;
    this.#toolbarKey = key;
    this.#toolbarResize?.disconnect();
    this.#titlebar?.remove();
    this.#titlebar = null;
    this.#viewer.style.height = "100%";
    if (!this.#toolbar) return;
    const bar = document.createElement("div");
    bar.className = "perspective-panel-titlebar";
    bar.style.cssText =
      "display:flex;flex-wrap:wrap;align-items:center;gap:.375rem;box-sizing:border-box;padding:.375rem .5rem;color:var(--spa-text,inherit);background:var(--spa-surface,inherit)";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Open channel");
    select.append(new Option("Open channel…", ""));
    for (const [name, config] of Object.entries(this.#config.channels ?? {})) {
      select.append(new Option(config.title ?? name, name));
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close channel";
    close.disabled = true;
    select.addEventListener("change", () => {
      close.disabled = !select.value;
      if (select.value)
        void this.openChannel(select.value).catch((error) =>
          this.#reportError(error),
        );
    });
    close.addEventListener("click", () => {
      if (select.value)
        void this.closeChannel(select.value).catch((error) =>
          this.#reportError(error),
        );
      select.value = "";
      close.disabled = true;
    });
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy selection";
    copy.addEventListener("click", () => void this.copySelection());
    bar.append(select, close, copy);
    if (this.#find) {
      const find = document.createElement("button");
      find.type = "button";
      find.textContent = "Find";
      find.addEventListener("click", () => void this.openFind());
      bar.append(find);
    }
    for (const control of [select, ...bar.querySelectorAll("button")]) {
      control.style.cssText =
        "box-sizing:border-box;flex:0 0 auto;width:auto;max-width:100%;height:2rem;min-height:2rem;margin:0;padding:.25rem .625rem;font-size:.875rem;line-height:1.25;white-space:nowrap";
    }
    select.style.flex = "0 1 16rem";
    select.style.minWidth = "0";
    this.prepend(bar);
    this.#titlebar = bar;
    this.#toolbarResize ??= new ResizeObserver(() => {
      if (this.#viewer && this.#titlebar)
        this.#viewer.style.height = `calc(100% - ${this.#titlebar.getBoundingClientRect().height}px)`;
    });
    this.#viewer.style.height = `calc(100% - ${bar.getBoundingClientRect().height}px)`;
    this.#toolbarResize.observe(bar);
  }

  // Element-level options, each a serializable prop queued behind wasm init.
  set themes(names: string[] | null) {
    if (names != null) {
      if (!Array.isArray(names)) throw new TypeError("themes: expected array");
      names.forEach((name, i) => validateTheme(name, `themes[${i}]`));
    }
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

  // Update each panel once, including inactive tabs and filter-source overrides.
  async #restoreTheme(config = this.#config): Promise<void> {
    if (!this.#viewer) return;
    const viewer = this.#viewer;
    const ws = (await viewer.saveWorkspace()) as Workspace;
    const masters = ws.masters ?? [];
    await Promise.all(
      Object.keys(ws.panels ?? {}).map((id) =>
        viewer.restore(
          { theme: this.#panelTheme(masters.includes(id), config) },
          { panel: id },
        ),
      ),
    );
  }

  #panelTheme(master: boolean, config = this.#config): string {
    const theme = master ? config.master_theme : undefined;
    return theme ? (THEMES[theme] ?? theme) : this.#theme;
  }

  // Saved themes belong to the previous session. Resolve every panel before
  // restoration so plugins never draw with a theme that needs correcting.
  #themedLayout(layout: Workspace, config: PerspectiveConfig): Workspace {
    const cloned = structuredClone(layout);
    for (const [id, panel] of Object.entries(cloned.panels ?? {})) {
      panel.theme = this.#panelTheme(
        cloned.masters?.includes(id) ?? false,
        config,
      );
    }
    return cloned;
  }

  #rememberChannels(workspace: Workspace, config = this.#config): void {
    workspace = this.#actionColumns?.clean(workspace) ?? workspace;
    for (const panel of Object.values(workspace.panels ?? {})) {
      if (hasOwn(config.channels ?? {}, panel.table)) {
        this.#channelConfigs.set(panel.table, structuredClone(panel));
      }
    }
  }

  async #restoreWorkspace(
    workspace: Workspace,
    config = this.#config,
  ): Promise<void> {
    if (!this.#viewer) return;
    const prepared = this.#themedLayout(migrateLayout(workspace), config);
    for (const [name, cached] of Object.entries(
      prepared.closed_channels ?? {},
    )) {
      if (hasOwn(config.channels ?? {}, name)) {
        this.#channelConfigs.set(name, structuredClone(cached));
      }
    }
    delete prepared.closed_channels;
    this.#rememberChannels(prepared, config);
    if (config.single_tab && prepared.panels) {
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

  /** Open a named table using its last channel configuration or configured defaults. */
  openChannel(name: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!hasOwn(this.#config.channels ?? {}, name))
        throw new Error(`Unknown channel: ${name}`);
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      this.#rememberChannels(workspace);
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
        this.#channelConfigs.get(name) ?? {
          ...this.#config.channels![name],
          table: name,
        },
      );
      const stack = tabStacks(workspace.layout).find((tabs) =>
        tabs.tabs.some((tab) => !workspace.masters?.includes(tab)),
      );
      if (stack) {
        stack.tabs.push(id);
        stack.selected = stack.tabs.length - 1;
      } else if (workspace.layout) {
        workspace.layout = {
          type: "split-layout",
          orientation: "horizontal",
          sizes: [1, 3],
          children: [workspace.layout, { type: "tab-layout", tabs: [id] }],
        };
      } else {
        workspace.layout = { type: "tab-layout", tabs: [id] };
      }
      await this.#restoreWorkspace(workspace);
    });
  }

  /** Close a channel, retaining its configuration for reopen and saveClean(). */
  closeChannel(name: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!hasOwn(this.#config.channels ?? {}, name))
        throw new Error(`Unknown channel: ${name}`);
      if (!this.#loaded || !this.#viewer)
        throw new Error("Perspective panel is not ready");
      const workspace = (await this.#viewer.saveWorkspace()) as Workspace;
      this.#rememberChannels(workspace);
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
  // view, and refresh its local snapshot (with the configured index/limit) on changes.
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
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        if (!this.#viewer) return;
        try {
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
          if (this.#loaded && config.layout) {
            const layout = JSON.stringify(config.layout);
            if (layout !== this.#lastLayout) {
              // Perspective 5.5 errors on a `table` no loaded client hosts; `wait_for_table`
              // restores the earlier behavior, a pending panel that fills once it is created
              this.#channelConfigs.clear();
              this.#lastLayout = null;
              this.#actionColumns?.reset();
              await this.#restoreWorkspace(config.layout as Workspace, config);
              this.#lastLayout = layout;
            } else if (!!config.single_tab !== this.#lastSingleTab) {
              await this.#restoreWorkspace(
                (await this.#viewer.saveWorkspace()) as Workspace,
                config,
              );
            } else if (config.master_theme !== this.#lastMasterTheme) {
              await this.#restoreTheme(config);
            }
          }
          this.#lastMasterTheme = config.master_theme;
          this.#lastSingleTab = !!config.single_tab;
          this.#renderToolbar();
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
      (this.#config.layout && this.#lastLayout === null) ||
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
  async save(): Promise<unknown> {
    await this.#queue.catch(() => {});
    await this.#actionColumns?.refresh();
    const workspace = (await this.#viewer?.saveWorkspace()) as
      | Workspace
      | undefined;
    if (!workspace) return workspace;
    const clean = this.#actionColumns?.clean(workspace) ?? workspace;
    this.#rememberChannels(clean);
    const open = new Set(
      Object.values(clean.panels ?? {}).map((panel) => panel.table),
    );
    const closed = Object.fromEntries(
      [...this.#channelConfigs].filter(
        ([name]) =>
          hasOwn(this.#config.channels ?? {}, name) && !open.has(name),
      ),
    );
    if (Object.keys(closed).length)
      clean.closed_channels = structuredClone(closed);
    return clean;
  }

  /** `save()` minus per-session transient state — panel themes and column size overrides — so the
   * result is portable across sessions and themes: the shape to persist or export. Made for
   * spaday's `Invoke` action: `Invoke(by_id("workspace"), "saveClean", result="custom_layout")`. */
  async saveClean(): Promise<unknown> {
    const layout = (await this.save()) as Workspace | null;
    if (!layout) return layout;
    const cleaned = structuredClone(layout);
    for (const panel of [
      ...Object.values(cleaned.panels ?? {}),
      ...Object.values(cleaned.closed_channels ?? {}),
    ]) {
      delete panel.theme;
      for (const column of Object.values(panel.plugin_config?.columns ?? {})) {
        delete column.column_size_override;
      }
    }
    return cleaned;
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
