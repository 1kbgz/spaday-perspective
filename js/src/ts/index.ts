import perspective from "@perspective-dev/client";
import perspectiveViewer from "@perspective-dev/viewer";
import CLIENT_WASM from "@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm";
import PRO from "@perspective-dev/viewer/dist/css/pro.css";
import PRO_DARK from "@perspective-dev/viewer/dist/css/pro-dark.css";
import WORKSPACE_CSS from "@perspective-dev/workspace/dist/css/workspace.css";
import "@perspective-dev/workspace";
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
  style.textContent = [WORKSPACE_CSS, PRO, PRO_DARK].join("\n");
  document.head.appendChild(style);
}

function wsUrl(url: string): string {
  if (/^wss?:\/\//.test(url)) return url;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${url.startsWith("/") ? "" : "/"}${url}`;
}

type Workspace = HTMLElement & {
  load(client: unknown): Promise<void>;
  restore(layout: unknown): Promise<void>;
  save(): Promise<unknown>;
  resize(): Promise<void>;
};

class PerspectivePanel extends HTMLElement {
  #workspace: Workspace | null = null;
  #config: PerspectiveConfig = {};
  #connectedUrl: string | null = null;
  #lastLayout: string | null = null;
  #theme = "Pro Light";
  #queue: Promise<unknown> = Promise.resolve();
  #resizeObserver: ResizeObserver | null = null;
  #resizeRaf = 0;

  connectedCallback(): void {
    injectStyles();
    if (!this.#workspace) {
      this.style.display ||= "block";
      this.#workspace = document.createElement(
        "perspective-workspace",
      ) as Workspace;
      this.appendChild(this.#workspace);
      this.#workspace.addEventListener("workspace-new-view", () =>
        this.#applyTheme(),
      );
    }
    if (!this.#resizeObserver && typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => {
        if (this.#resizeRaf) return;
        this.#resizeRaf = requestAnimationFrame(() => {
          this.#resizeRaf = 0;
          void this.#workspace?.resize();
        });
      });
      this.#resizeObserver.observe(this);
    }
    this.#apply();
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#resizeRaf) cancelAnimationFrame(this.#resizeRaf);
    this.#resizeRaf = 0;
  }

  set theme(name: string) {
    this.#theme = THEMES[name] ?? name;
    this.#applyTheme();
  }
  get theme(): string {
    return this.#theme;
  }

  set config(config: PerspectiveConfig) {
    this.#config = config || {};
    this.#apply();
  }
  get config(): PerspectiveConfig {
    return this.#config;
  }

  #applyTheme(): void {
    if (!this.#workspace) return;
    this.#workspace.setAttribute("theme", this.#theme);
    for (const viewer of this.#workspace.querySelectorAll(
      "perspective-viewer",
    )) {
      viewer.setAttribute("theme", this.#theme);
    }
  }

  #apply(): void {
    const config = this.#config;
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        await ready;
        if (!this.#workspace) return;
        if (config.ws_url && config.ws_url !== this.#connectedUrl) {
          this.#connectedUrl = config.ws_url;
          const client = await perspective.websocket(wsUrl(config.ws_url));
          await this.#workspace.load(client);
        }
        if (this.#connectedUrl && config.layout) {
          const layout = JSON.stringify(config.layout);
          if (layout !== this.#lastLayout) {
            this.#lastLayout = layout;
            await this.#workspace.restore(config.layout);
          }
        }
        this.#applyTheme();
      });
  }

  async save(): Promise<unknown> {
    await this.#queue.catch(() => {});
    return this.#workspace?.save();
  }
}

if (!customElements.get("perspective-panel")) {
  customElements.define("perspective-panel", PerspectivePanel);
}

export { PerspectivePanel };
