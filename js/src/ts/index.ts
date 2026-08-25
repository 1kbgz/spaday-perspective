import perspective from "@perspective-dev/client";
import perspectiveViewer from "@perspective-dev/viewer";
import CLIENT_WASM from "@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm";
import SERVER_WASM from "@perspective-dev/server/dist/wasm/perspective-server.wasm";
import PRO from "@perspective-dev/viewer/dist/css/pro.css";
import PRO_DARK from "@perspective-dev/viewer/dist/css/pro-dark.css";
import "@perspective-dev/viewer-datagrid";
import "@perspective-dev/viewer-charts";

export type PerspectiveArchitecture = "server" | "client-server";

export interface PerspectiveTableConfig {
  name: string;
  architecture?: PerspectiveArchitecture;
  index?: string;
  limit?: number;
}

export interface PerspectiveConfig {
  ws_url?: string;
  tables?: (string | PerspectiveTableConfig)[];
  default_architecture?: PerspectiveArchitecture;
  layout?: unknown;
}

type PspClient = Awaited<ReturnType<typeof perspective.websocket>>;
type PspTable = Awaited<ReturnType<PspClient["open_table"]>>;
type PspView = Awaited<ReturnType<PspTable["view"]>>;

const ready = perspectiveViewer.init_client(CLIENT_WASM);
// registration only — the engine binary is instantiated on the first `worker()` call
// (a `client-server` table architecture), so `server`-only pages never pay for it
perspective.init_server(SERVER_WASM);
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

function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = [PRO, PRO_DARK].join("\n");
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
type Viewer = HTMLElement & {
  load(client: unknown): Promise<void>;
  restore(config: unknown, options?: { panel?: string }): Promise<void>;
  restoreWorkspace(config: unknown): Promise<void>;
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
  #lastMirrored: string | null = null;
  #local: PspClient | null = null;
  #localLoaded = false;
  #mirrors: { view: PspView; table: PspTable }[] = [];
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

  connectedCallback(): void {
    injectStyles();
    if (!this.#viewer) {
      this.style.display ||= "block";
      this.#viewer = document.createElement("perspective-viewer") as Viewer;
      // the viewer has no intrinsic height; fill the panel, which the embedder sizes
      this.#viewer.style.height = "100%";
      this.appendChild(this.#viewer);
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
    this.#followPageMode();
    this.#apply();
  }

  /** The underlying `<perspective-viewer>` — the escape hatch for its imperative/query
   * API (`getTable`, `download`, `copy`, `getSelection`, agent methods, ...). */
  get viewer(): HTMLElement | null {
    return this.#viewer;
  }

  disconnectedCallback(): void {
    this.#modeObserver?.disconnect();
    this.#modeObserver = null;
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
    this.#config = config || {};
    this.#apply();
  }
  get config(): PerspectiveConfig {
    return this.#config;
  }

  // Element-level options, each a serializable prop queued behind wasm init.
  set themes(names: string[] | null) {
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

  #enqueue(step: () => unknown): void {
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        await step();
      });
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

  // Perspective 5 stamps a concrete theme per panel at creation and a bare
  // restore({theme}) restyles only the ACTIVE panel, so background panels keep
  // rendering their old theme. Restore the element chrome + active panel first,
  // then stamp every panel by id — concurrently: each restore restyles that
  // panel's plugin, so serial stamping lags with tab count (~300ms at 8 panels
  // vs ~150ms concurrent). The restores touch disjoint panels and run inside
  // the queue, so no layout replacement can interleave with them.
  async #restoreTheme(): Promise<void> {
    if (!this.#viewer) return;
    const viewer = this.#viewer;
    await viewer.restore({ theme: this.#theme });
    const ws = (await viewer.saveWorkspace()) as {
      panels?: Record<string, unknown>;
    };
    await Promise.all(
      Object.keys(ws.panels ?? {}).map((id) =>
        viewer.restore({ theme: this.#theme }, { panel: id }),
      ),
    );
  }

  // A workspace restore creates each panel with its config's theme (or the light
  // registry default) — stamp the current theme into panels that carry none, the
  // same fill-in the legacy csp-gateway UI applies before restoring.
  #themedLayout(layout: unknown): unknown {
    const cloned = JSON.parse(JSON.stringify(layout)) as {
      panels?: Record<string, { theme?: string }>;
    };
    for (const panel of Object.values(cloned.panels ?? {})) {
      panel.theme ||= this.#theme;
    }
    return cloned;
  }

  // `client-server` tables mirror into a local worker: open the server table, take a
  // view, seed a local table from its arrow (with the configured index/limit), and feed
  // row deltas forward. `viewer.load` ACCUMULATES clients and resolves panel table names
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
    for (const mirror of this.#mirrors.splice(0)) {
      await mirror.view.delete().catch(() => {});
      await mirror.table.delete({ lazy: true }).catch(() => {});
    }
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
            const remote = await perspective.websocket(wsUrl(config.ws_url));
            if (mirrored.length) {
              this.#local ??= await perspective.worker();
              for (const t of mirrored) {
                const serverTable = await remote.open_table(t.name);
                const view = await serverTable.view();
                const table = await this.#local.table(await view.to_arrow(), {
                  name: t.name,
                  index: t.index,
                  limit: t.limit,
                });
                await view.on_update(
                  async (updated: { delta?: ArrayBuffer }) => {
                    if (updated?.delta) await table.update(updated.delta);
                  },
                  { mode: "row" },
                );
                this.#mirrors.push({ view, table });
              }
              if (!this.#localLoaded) {
                this.#localLoaded = true;
                await this.#viewer.load(this.#local);
              }
            }
            await this.#viewer.load(remote);
            this.#loaded = true;
          }
          if (this.#connectedUrl && config.layout) {
            const layout = JSON.stringify(config.layout);
            if (layout !== this.#lastLayout) {
              this.#lastLayout = layout;
              await this.#viewer.restoreWorkspace(
                this.#themedLayout(config.layout),
              );
              // Perspective 5.2: restoring a layout with no `active` (sidebar closed)
              // onto an already-closed element force-toggles settings as a no-op but
              // still flips the persisted flag + host `settings` attribute — the
              // datagrid then shows per-column Edit buttons and eats the next settings
              // click. A bare toggleConfig() flips the stale flag back without opening.
              if (
                this.#settings !== true &&
                !(config.layout as { active?: unknown }).active &&
                this.#viewer.hasAttribute("settings")
              ) {
                await this.#viewer.toggleConfig();
              }
            }
          }
          if (this.#loaded) {
            await this.#viewer.restore({ theme: this.#theme });
          }
          // one-shot readiness: connected, tables loaded, and the initial workspace
          // config (when the config carries one) applied and rendered — the stable
          // signal a branded startup overlay can key off, unlike
          // perspective-config-update, which describes config changes and never
          // fires when initialization fails
          if (
            !this.#readyFired &&
            this.#loaded &&
            (!config.layout || this.#lastLayout !== null)
          ) {
            this.#readyFired = true;
            await this.#viewer.flush();
            this.dispatchEvent(
              new CustomEvent("perspective-ready", {
                bubbles: true,
                composed: true,
              }),
            );
          }
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

  /** The whole-element workspace config (layout tree + per-panel viewer configs). */
  async save(): Promise<unknown> {
    await this.#queue.catch(() => {});
    return this.#viewer?.saveWorkspace();
  }
}

if (!customElements.get("perspective-panel")) {
  customElements.define("perspective-panel", PerspectivePanel);
}

export { PerspectivePanel };
