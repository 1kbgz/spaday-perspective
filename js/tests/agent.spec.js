import { expect, test } from "@playwright/test";

// `agentConfig`, `agentPrompt` and `agentReset` are the viewer's own; these check the panel hands
// them through and re-dispatches `perspective-agent-tool`. The model is an in-page fake engine.
async function mount(page) {
  await page.goto("/dist/index.html");
  await page.evaluate(async () => {
    const client = await globalThis.__spadayPerspective.worker();
    await client.table([{ id: 1, value: 10 }], { name: "agent", index: "id" });
    const panel = document.createElement("perspective-panel");
    panel.id = "agent-panel";
    panel.style.cssText = "display:block;width:700px;height:300px";
    panel.config = {
      local: true,
      layout: {
        layout: { type: "tab-layout", tabs: ["main"] },
        panels: { main: { table: "agent", plugin: "Datagrid" } },
      },
    };
    window.tools = [];
    panel.addEventListener("perspective-agent-tool", (event) =>
      window.tools.push(JSON.parse(event.detail).name),
    );
    document.body.append(panel);
    await panel.save();
    // each step is one model reply: a tool call or the final text
    window.engine = (script) => ({
      chat: {
        completions: {
          create: async () => {
            const step = script.shift();
            if (!step) throw new Error("Fake engine script exhausted");
            const message = step.tool
              ? {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: `call_${script.length}`,
                      type: "function",
                      function: { name: step.tool, arguments: "{}" },
                    },
                  ],
                }
              : { role: "assistant", content: step.text };
            return {
              id: `chatcmpl-${script.length}`,
              object: "chat.completion",
              created: 0,
              model: "fake-model",
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: step.tool ? "tool_calls" : "stop",
                },
              ],
            };
          },
        },
      },
    });
  });
  await expect(
    page.locator("#agent-panel regular-table tbody td").first(),
  ).toBeVisible();
}

test("a prompt resolves with the reply and tool calls re-dispatch from the panel", async ({
  page,
}) => {
  await mount(page);
  const answer = await page.evaluate(async () => {
    const panel = document.querySelector("#agent-panel");
    const configured = panel.agentConfig({
      name: "fake",
      engine: window.engine([{ tool: "list_panels" }, { text: "One panel." }]),
    });
    return [configured, await panel.agentPrompt("How many panels?")];
  });
  expect(answer).toEqual([undefined, "One panel."]);
  expect(await page.evaluate(() => window.tools)).toEqual(["list_panels"]);
});

test("agentReset keeps the configuration", async ({ page }) => {
  await mount(page);
  const answers = await page.evaluate(async () => {
    const panel = document.querySelector("#agent-panel");
    panel.agentConfig({
      name: "fake",
      engine: window.engine([{ text: "First." }, { text: "Second." }]),
    });
    const first = await panel.agentPrompt("one");
    await panel.agentReset();
    return [first, await panel.agentPrompt("two")];
  });
  expect(answers).toEqual(["First.", "Second."]);
});

test("a panel that was never connected throws and rejects", async ({
  page,
}) => {
  await page.goto("/dist/index.html");
  await page.evaluate(() => customElements.whenDefined("perspective-panel"));
  const errors = await page.evaluate(async () => {
    const panel = document.createElement("perspective-panel");
    const message = (error) => error.message;
    let thrown;
    try {
      panel.agentConfig({ url: "/chat" });
    } catch (error) {
      thrown = error.message;
    }
    return [
      thrown,
      await panel.agentPrompt("hello").catch(message),
      await panel.agentReset().catch(message),
    ];
  });
  expect(errors).toEqual(Array(3).fill("Perspective panel is not connected"));
});

test("the agent docs bundle is served next to the viewer", async ({ page }) => {
  const response = await page.request.get(
    "/dist/vendor/@perspective-dev/viewer/dist/docs/perspective-docs.json",
  );
  expect(response.ok()).toBe(true);
  expect(typeof (await response.json())).toBe("object");
});
