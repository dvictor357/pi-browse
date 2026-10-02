import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import { BrowserManager } from "../src/browser";
import { loadConfig } from "../src/config";

test("close waits for an in-flight launch and leaves no browser running", async (t) => {
	let finishLaunch!: (context: BrowserContext) => void;
	let closes = 0;
	const context = {
		setDefaultTimeout() {},
		setDefaultNavigationTimeout() {},
		on() {},
		routeWebSocket: async () => {},
		pages: () => [],
		close: async () => {
			closes++;
		},
	} as unknown as BrowserContext;
	t.mock.method(
		chromium,
		"launchPersistentContext",
		() =>
			new Promise<BrowserContext>((resolve) => {
				finishLaunch = resolve;
			}),
	);
	const browser = new BrowserManager(() =>
		loadConfig({ executablePath: "/mock/chromium", idleCloseMs: 0 }),
	);
	const opening = browser.getContext();
	const closing = browser.close();
	finishLaunch(context);
	await Promise.all([opening, closing]);
	try {
		assert.equal(closes, 1);
		assert.equal(browser.isRunning, false);
	} finally {
		await browser.close();
	}
});
