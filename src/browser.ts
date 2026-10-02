import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { BrowseConfig } from "./config";
import { assertUrlAllowed } from "./ssrf";
import { parseProxy } from "./util";

export const DEFAULT_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/**
 * One persistent Chromium context per pi process.
 *
 * A persistent profile means cookies, logins, and localStorage survive across
 * tool calls and pi restarts, which is what makes multi-step browsing possible.
 * The browser is launched lazily on first use and closed after an idle period.
 */
export class BrowserManager {
	private context: BrowserContext | null = null;
	private launching: Promise<BrowserContext> | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private headlessOverride: boolean | undefined;
	private guardedPages = new WeakMap<Page, Promise<void>>();

	constructor(private readonly getConfig: () => BrowseConfig) {}

	get isRunning(): boolean {
		return this.context !== null;
	}

	isHeadless(): boolean {
		return this.headlessOverride ?? this.getConfig().headless;
	}

	/** Toggle headless/headed. Closes the current browser; the next call relaunches. */
	async setHeadless(headless: boolean): Promise<void> {
		this.headlessOverride = headless;
		await this.close();
	}

	async getContext(): Promise<BrowserContext> {
		if (this.context) {
			this.touch();
			return this.context;
		}
		if (!this.launching) this.launching = this.launch();
		try {
			this.context = await this.launching;
			return this.context;
		} finally {
			this.launching = null;
		}
	}

	private async launch(): Promise<BrowserContext> {
		const cfg = this.getConfig();
		const context = await chromium.launchPersistentContext(cfg.profileDir, {
			headless: this.headlessOverride ?? cfg.headless,
			executablePath: this.resolveExecutable(cfg),
			viewport: { width: 1440, height: 900 },
			locale: cfg.locale,
			userAgent: cfg.userAgent ?? DEFAULT_UA,
			proxy: cfg.proxy ? parseProxy(cfg.proxy) : undefined,
			serviceWorkers: "block",
			args: [
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-blink-features=AutomationControlled",
				"--disable-dev-shm-usage",
			],
		});
		context.setDefaultTimeout(cfg.timeoutMs);
		context.setDefaultNavigationTimeout(cfg.timeoutMs);
		context.on("close", () => {
			if (this.context === context) this.context = null;
		});
		context.on("page", (page) => {
			void this.guardPage(context, page).catch(() => page.close().catch(() => {}));
		});
		try {
			await context.routeWebSocket("**/*", async (socket) => {
				try {
					const url = new URL(socket.url());
					url.protocol = url.protocol === "wss:" ? "https:" : "http:";
					await assertUrlAllowed(url.toString(), this.getConfig());
					socket.connectToServer();
				} catch {
					socket.close();
				}
			});
			await Promise.all(context.pages().map((page) => this.guardPage(context, page)));
		} catch (err) {
			await context.close();
			throw err;
		}
		this.touch();
		return context;
	}

	private guardPage(context: BrowserContext, page: Page): Promise<void> {
		let ready = this.guardedPages.get(page);
		if (!ready) {
			ready = (async () => {
				const client = await context.newCDPSession(page);
				client.on("Fetch.requestPaused", (event) => {
					void (async () => {
						try {
							await assertUrlAllowed(event.request.url, this.getConfig());
							await client.send("Fetch.continueRequest", { requestId: event.requestId });
						} catch {
							await client.send("Fetch.failRequest", {
								requestId: event.requestId,
								errorReason: "AccessDenied",
							});
						}
					})().catch(() => {}); // The page can close while a DNS check is pending.
				});
				// Playwright routing sees only the first URL in a redirect chain.
				// CDP request-stage interception also sees every redirected request.
				await client.send("Fetch.enable", {
					patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
				});
			})();
			this.guardedPages.set(page, ready);
		}
		return ready;
	}

	private resolveExecutable(cfg: BrowseConfig): string | undefined {
		if (cfg.executablePath) return cfg.executablePath;
		try {
			const path = chromium.executablePath();
			if (path && existsSync(path)) return path;
		} catch {
			// Not installed under the current PLAYWRIGHT_BROWSERS_PATH.
		}
		throw new Error(
			"pi-browse: no Chromium binary found. Run `npx playwright install chromium`, or set `executablePath` in ~/.pi/agent/pi-browse.json.",
		);
	}

	/** The most recently opened tab, or a new one. */
	async page(): Promise<Page> {
		const context = await this.getContext();
		const open = context.pages().filter((page) => !page.isClosed());
		const page = open.length > 0 ? open[open.length - 1] : await context.newPage();
		await this.guardPage(context, page);
		return page;
	}

	async newPage(): Promise<Page> {
		const context = await this.getContext();
		const page = await context.newPage();
		await this.guardPage(context, page);
		return page;
	}

	tabCount(): number {
		if (!this.context) return 0;
		return this.context.pages().filter((page) => !page.isClosed()).length;
	}

	currentUrl(): string | undefined {
		if (!this.context) return undefined;
		const pages = this.context.pages().filter((page) => !page.isClosed());
		return pages.length > 0 ? pages[pages.length - 1].url() : undefined;
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const { idleCloseMs } = this.getConfig();
		if (!idleCloseMs) {
			this.idleTimer = null;
			return;
		}
		this.idleTimer = setTimeout(() => void this.close(), idleCloseMs);
		this.idleTimer.unref?.();
	}

	async close(): Promise<void> {
		// Shutdown/mode changes can arrive before the first launch finishes.
		if (this.launching) await this.launching.catch(() => {});
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		const context = this.context;
		this.context = null;
		if (context) {
			try {
				await context.close();
			} catch {
				// Already gone (crash or manual close).
			}
		}
	}
}
