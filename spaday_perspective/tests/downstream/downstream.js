/* A stand-in for a downstream component library.
 *
 * It builds its own component on top of Perspective, but imports NOTHING from `@perspective-dev`:
 * it borrows the page's one engine through `globalThis.__spadayPerspective` and uses the
 * `<perspective-viewer>` element spaday-perspective already registered. Not importing is the whole
 * point -- a second copy of Perspective on the page throws from `customElements.define` and the two
 * cannot coexist.
 *
 * Its data comes from rows handed to it in the page, not from a server, which is the case that
 * genuinely differs from `<perspective-panel>` and the reason an application would want both.
 */

let tableSeq = 0;

class DemoRowsGrid extends HTMLElement {
  #rows = [];
  #viewer = null;
  #table = null;
  #name = `demo_rows_${(tableSeq += 1)}`;
  #queue = Promise.resolve();

  static get observedAttributes() {
    return [];
  }

  get rows() {
    return this.#rows;
  }

  set rows(value) {
    this.#rows = Array.isArray(value) ? value : [];
    this.#render();
  }

  connectedCallback() {
    this.style.display ||= "block";
    this.#render();
  }

  // the borrowed engine, recorded so a test can assert it is the same object the panel uses
  async borrowedWorker() {
    const lender = globalThis.__spadayPerspective;
    if (!lender) throw new Error("spaday-perspective did not publish an engine to borrow");
    return lender.worker();
  }

  #render() {
    if (!this.isConnected || !this.#rows.length) return;
    this.#queue = this.#queue
      .catch(() => {})
      .then(async () => {
        const client = await this.borrowedWorker();
        this.dataset.engineVersion = globalThis.__spadayPerspective.version;
        if (!this.#table) {
          this.#table = await client.table(this.#rows, { name: this.#name });
        } else {
          await this.#table.replace(this.#rows);
        }
        if (!this.#viewer) {
          this.#viewer = document.createElement("perspective-viewer");
          this.#viewer.style.cssText = "display:block;width:100%;height:100%";
          this.appendChild(this.#viewer);
          await this.#viewer.load(client);
          await this.#viewer.restoreWorkspace({
            layout: { type: "tab-layout", tabs: [this.#name] },
            panels: { [this.#name]: { table: this.#name, plugin: "Datagrid" } },
          });
        }
        this.dispatchEvent(
          new CustomEvent("demo-grid-ready", { bubbles: true, composed: true }),
        );
      })
      // a queued failure would otherwise be swallowed by the next call's catch, leaving a test
      // looking at an empty element with nothing to explain it
      .catch((error) => {
        this.dataset.error = String(error?.message ?? error);
        throw error;
      });
    return this.#queue;
  }
}

if (!customElements.get("demo-rows-grid")) {
  customElements.define("demo-rows-grid", DemoRowsGrid);
}

export { DemoRowsGrid };
