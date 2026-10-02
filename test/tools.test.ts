import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "../src/browser";
import { loadConfig } from "../src/config";
import { registerTools } from "../src/tools";

function tools(browser: BrowserManager) {
	const registered = new Map<string, ToolDefinition>();
	registerTools(
		{
			registerTool: (tool: ToolDefinition) => {
				registered.set(tool.name, tool);
			},
		} as ExtensionAPI,
		{ browser, getConfig: () => loadConfig() },
	);
	return registered;
}

const ctx = {} as Parameters<ToolDefinition["execute"]>[4];

test("shared browser tools request sequential execution", () => {
	const registered = tools(new BrowserManager(() => loadConfig()));
	for (const name of ["browse", "browse_act", "browse_screenshot", "web_search"]) {
		assert.equal(registered.get(name)?.executionMode, "sequential", name);
	}
});

test("fetch_url enforces its timeout and combines caller cancellation", async (t) => {
	let received: AbortSignal | null | undefined;
	t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
		received = init.signal;
		return new Promise<Response>((_resolve, reject) => {
			const fail = () => reject(received?.reason);
			if (received?.aborted) fail();
			else received?.addEventListener("abort", fail, { once: true });
		});
	});
	const tool = tools(new BrowserManager(() => loadConfig())).get("fetch_url")!;
	// A keepalive lets AbortSignal.timeout's unref'd timer fire in this network mock.
	const keepalive = setTimeout(() => {}, 5000);
	let watchdog: NodeJS.Timeout | undefined;
	try {
		const result = await Promise.race([
			tool.execute(
				"timeout",
				{ url: "https://1.1.1.1/", timeoutMs: 20 },
				undefined,
				undefined,
				ctx,
			),
			new Promise<never>((_resolve, reject) => {
				watchdog = setTimeout(() => reject(new Error("fetch_url ignored timeoutMs")), 500);
			}),
		]);
		assert.equal(result.isError, true);
		assert.equal(received?.aborted, true);
		assert.match(JSON.stringify(result.content), /timeout/i);

		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		const cancelled = await tool.execute(
			"cancel",
			{ url: "https://1.1.1.1/", timeoutMs: 5000 },
			controller.signal,
			undefined,
			ctx,
		);
		assert.equal(cancelled.isError, true);
		assert.match(JSON.stringify(cancelled.content), /cancelled by caller/);
	} finally {
		clearTimeout(keepalive);
		clearTimeout(watchdog);
	}
});

test("browse_act reports a failed action and skips subsequent actions", async () => {
	let clicks = 0;
	const page = {
		setDefaultTimeout() {},
		setDefaultNavigationTimeout() {},
		locator: () => ({
			first: () => ({
				click: async () => {
					clicks++;
					throw new Error("button missing");
				},
			}),
		}),
		waitForLoadState: async () => {},
		evaluate: async () => {},
		url: () => "https://example.com/",
		content: async () => "<html><body>Still here</body></html>",
	};
	const browser = { page: async () => page, tabCount: () => 1 } as unknown as BrowserManager;
	const result = await tools(browser)
		.get("browse_act")!
		.execute(
			"act",
			{
				actions: [
					{ type: "click", selector: "#missing" },
					{ type: "click", selector: "#next" },
				],
				mode: "html",
			},
			undefined,
			undefined,
			ctx,
		);
	assert.equal(result.isError, true);
	assert.equal(clicks, 1);
	assert.match(JSON.stringify(result.content), /button missing/);
});
