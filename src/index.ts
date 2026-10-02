import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "./browser";
import { loadConfig } from "./config";
import { assertUrlAllowed } from "./ssrf";
import { registerTools } from "./tools";
import { errorMessage, settle } from "./util";

/**
 * pi-browse — browser-first web access for pi.
 *
 * Tools:  browse · browse_act · browse_screenshot · fetch_url · web_search
 * Commands: /browse <url> · /browse-mode (headless↔headed) · /browse-close
 *
 * One persistent Chromium profile is shared per pi process, so cookies and
 * logins survive between calls and across restarts. The browser is launched
 * lazily on first use and closed after an idle period or on shutdown.
 */
export default function (pi: ExtensionAPI) {
	const browser = new BrowserManager(() => loadConfig());

	registerTools(pi, { getConfig: () => loadConfig(), browser });

	pi.on("session_shutdown", async () => {
		await browser.close();
	});

	pi.registerCommand("browse", {
		description: "Open a URL in the pi browser and report its title",
		handler: async (args, ctx) => {
			const url = args.trim();
			if (!url) {
				ctx.ui.notify("Usage: /browse <url>", "warning");
				return;
			}
			try {
				const target = await assertUrlAllowed(url, loadConfig());
				const page = await browser.page();
				await page.goto(target.url, { waitUntil: "domcontentloaded" });
				await settle(page, 3000);
				ctx.ui.notify(`${await page.title()} — ${page.url()}`, "info");
			} catch (err) {
				ctx.ui.notify(`browse: ${errorMessage(err)}`, "error");
			}
		},
	});

	pi.registerCommand("browse-mode", {
		description: "Toggle the pi browser between headless and headed (visible) mode",
		handler: async (_args, ctx) => {
			const headless = !browser.isHeadless();
			await browser.setHeadless(headless);
			ctx.ui.notify(
				headless
					? "pi-browse: headless"
					: "pi-browse: headed — log in in the window, then run /browse-mode again to go headless",
				"info",
			);
		},
	});

	pi.registerCommand("browse-close", {
		description: "Close the pi browser and end the persistent session",
		handler: async (_args, ctx) => {
			await browser.close();
			ctx.ui.notify("pi-browse: browser closed", "info");
		},
	});
}
