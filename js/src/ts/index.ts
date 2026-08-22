import perspective from "@perspective-dev/client";
import perspectiveViewer from "@perspective-dev/viewer";
import CLIENT_WASM from "@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm";
import PRO from "@perspective-dev/viewer/dist/css/pro.css";
import PRO_DARK from "@perspective-dev/viewer/dist/css/pro-dark.css";
import "@perspective-dev/viewer-datagrid";

export interface PerspectiveConfig {
  ws_url?: string;
  tables?: string[];
  layout?: unknown;
}

const ready = perspectiveViewer.init_client(CLIENT_WASM);
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
  restore(config: unknown): Promise<void>;
  restoreWorkspace(config: unknown): Promise<void>;
  saveWorkspace(): Promise<unknown>;
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
    this.#enqueue(() => this.#viewer?.toggleConfig(this.#settings!));
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
  // in-flight load/restore (a pre-load restore is swallowed by the queue's
  // catch and re-applied at the end of the next #apply).
  #applyTheme(): void {
    this.#enqueue(() => this.#viewer?.restore({ theme: this.#theme }));
  }

  #apply(): void {
    const config = this.#config;
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        if (!this.#viewer) return;
        if (config.ws_url && config.ws_url !== this.#connectedUrl) {
          this.#connectedUrl = config.ws_url;
          const client = await perspective.websocket(wsUrl(config.ws_url));
          await this.#viewer.load(client);
        }
        if (this.#connectedUrl && config.layout) {
          const layout = JSON.stringify(config.layout);
          if (layout !== this.#lastLayout) {
            this.#lastLayout = layout;
            await this.#viewer.restoreWorkspace(config.layout);
          }
        }
        await this.#viewer.restore({ theme: this.#theme });
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
