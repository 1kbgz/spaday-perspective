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
// server table, `restore` accepts the whole-element workspace config, and
// `save` emits it. Theme is viewer config now, not an attribute; the element
// auto-sizes, so no manual resize plumbing.
type Viewer = HTMLElement & {
  load(client: unknown): Promise<void>;
  restore(config: unknown): Promise<void>;
  save(): Promise<unknown>;
};

class PerspectivePanel extends HTMLElement {
  #viewer: Viewer | null = null;
  #config: PerspectiveConfig = {};
  #connectedUrl: string | null = null;
  #lastLayout: string | null = null;
  #theme = "Pro Light";
  #explicitTheme = false;
  #modeObserver: MutationObserver | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  connectedCallback(): void {
    injectStyles();
    if (!this.#viewer) {
      this.style.display ||= "block";
      this.#viewer = document.createElement("perspective-viewer") as Viewer;
      this.appendChild(this.#viewer);
    }
    this.#followPageMode();
    this.#apply();
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

  // Theme rides viewer config in 5.x; queue it behind wasm init and any
  // in-flight load/restore (a pre-load restore is swallowed by the queue's
  // catch and re-applied at the end of the next #apply).
  #applyTheme(): void {
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        await this.#viewer?.restore({ theme: this.#theme });
      });
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
            await this.#viewer.restore(config.layout);
          }
        }
        await this.#viewer.restore({ theme: this.#theme });
      });
  }

  async save(): Promise<unknown> {
    await this.#queue.catch(() => {});
    return this.#viewer?.save();
  }
}

if (!customElements.get("perspective-panel")) {
  customElements.define("perspective-panel", PerspectivePanel);
}

export { PerspectivePanel };
