import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_UA, type BrowserManager } from "./browser";
import type { BrowseConfig } from "./config";
import { extract, type BrowseMode, type ExtractResult } from "./extract";
import { assertUrlAllowed, BlockedUrlError } from "./ssrf";
import { formatResults, search, type SearchProvider, type SearchResult } from "./search";
import { errorMessage, settle, truncate } from "./util";

export interface ToolDeps {
	getConfig: () => BrowseConfig;
	browser: BrowserManager;
}

const READ_MODES = ["readable", "text", "html", "links", "metadata"] as const;

interface BrowseDetails {
	url: string;
	finalUrl: string;
	title: string;
	mode: string;
	chars: number;
	truncated: boolean;
	status: number | null;
	elapsedMs: number;
	selector?: string;
	tabs: number;
}

interface ActDetails extends BrowseDetails {
	actions: string[];
}

interface ScreenshotDetails {
	url: string;
	path: string;
	bytes: number;
	fullPage: boolean;
	selector?: string;
}

interface FetchDetails {
	url: string;
	status: number;
	contentType: string;
	chars: number;
	truncated: boolean;
	elapsedMs: number;
}

interface SearchDetails {
	query: string;
	provider: string;
	count: number;
	elapsedMs: number;
	results: SearchResult[];
}

function headerFor(result: ExtractResult, url: string): string {
	const title = result.title || url;
	const meta = [
		result.site,
		result.byline,
		result.published,
		result.wordCount ? `${result.wordCount} words` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return meta ? `# ${title}\n${meta}\n${url}` : `# ${title}\n${url}`;
}

function renderResult(result: ExtractResult, url: string, maxChars: number) {
	const { text, truncated } = truncate(result.content, maxChars);
	const output = text ? `${headerFor(result, url)}\n\n${text}` : headerFor(result, url);
	return { output, truncated };
}

async function readPage(
	deps: ToolDeps,
	page: import("playwright-core").Page,
	mode: BrowseMode,
	selector: string | undefined,
): Promise<{ result: ExtractResult; output: string; truncated: boolean; finalUrl: string }> {
	const finalUrl = page.url();
	const result = await extract(await page.content(), finalUrl, mode, selector);
	const { output, truncated } = renderResult(result, finalUrl, deps.getConfig().maxChars);
	return { result, output, truncated, finalUrl };
}

const BrowseParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to open." }),
	mode: Type.Optional(
		StringEnum(READ_MODES, {
			description:
				"readable = main article as Markdown (default), text = article plain text, html = raw page HTML, links = all links, metadata = title/author/date only.",
		}),
	),
	selector: Type.Optional(
		Type.String({ description: "CSS selector to scope extraction to a single element's subtree." }),
	),
	waitFor: Type.Optional(
		Type.String({
			description: "CSS selector to wait for before extracting (useful for SPA content).",
		}),
	),
	waitMs: Type.Optional(
		Type.Number({ description: "Extra settle time in ms after load, capped at 15000." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Navigation timeout in ms." })),
	fresh: Type.Optional(
		Type.Boolean({ description: "Open in a new tab instead of reusing the current one." }),
	),
});

const ActionSchema = Type.Union([
	Type.Object({ type: Type.Literal("goto"), url: Type.String() }),
	Type.Object({
		type: Type.Literal("click"),
		selector: Type.Optional(Type.String()),
		text: Type.Optional(
			Type.String({ description: "Visible text to click when no selector is given." }),
		),
	}),
	Type.Object({
		type: Type.Literal("type"),
		selector: Type.String(),
		text: Type.String(),
		submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
	}),
	Type.Object({
		type: Type.Literal("press"),
		key: Type.String(),
		selector: Type.Optional(Type.String()),
	}),
	Type.Object({ type: Type.Literal("select"), selector: Type.String(), value: Type.String() }),
	Type.Object({
		type: Type.Literal("scroll"),
		y: Type.Optional(Type.Number({ description: "Pixels to scroll down (negative scrolls up)." })),
		selector: Type.Optional(Type.String({ description: "Scroll this element into view instead." })),
	}),
	Type.Object({
		type: Type.Literal("wait"),
		ms: Type.Optional(Type.Number()),
		selector: Type.Optional(Type.String()),
	}),
	Type.Object({ type: Type.Literal("back") }),
	Type.Object({ type: Type.Literal("forward") }),
	Type.Object({ type: Type.Literal("reload") }),
	Type.Object({ type: Type.Literal("eval"), expression: Type.String() }),
]);

const ActParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Open this URL before running actions." })),
	actions: Type.Array(ActionSchema, {
		description: "Ordered actions to perform on the live page.",
	}),
	mode: Type.Optional(
		StringEnum(READ_MODES, { description: "Extraction mode for the final page." }),
	),
	selector: Type.Optional(Type.String({ description: "CSS selector to scope final extraction." })),
	timeoutMs: Type.Optional(Type.Number()),
});

const ScreenshotParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Open this URL first." })),
	selector: Type.Optional(Type.String({ description: "Screenshot only this element." })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
	attach: Type.Optional(
		Type.Boolean({
			description: "Return the image to the model (default true). Set false to only save it.",
		}),
	),
});

const FetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch over plain HTTP (no browser)." }),
	mode: Type.Optional(
		StringEnum(["auto", "text", "markdown", "html", "json"] as const, {
			description: "auto = detect by content-type (default). markdown = readable article.",
		}),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), { description: "Extra request headers." }),
	),
	timeoutMs: Type.Optional(Type.Number()),
});

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query." }),
	numResults: Type.Optional(Type.Number({ description: "Max results (default 8, cap 20)." })),
	site: Type.Optional(
		Type.String({ description: "Restrict results to a domain, e.g. github.com." }),
	),
	provider: Type.Optional(StringEnum(["auto", "duckduckgo", "bing"] as const)),
});

/** Follow redirects manually so every hop passes the SSRF guard. */
async function safeFetch(
	rawUrl: string,
	cfg: BrowseConfig,
	init: RequestInit,
	maxRedirects = 5,
): Promise<{ response: Response; finalUrl: string }> {
	let current = rawUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const target = await assertUrlAllowed(current, cfg);
		const response = await fetch(target.url, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if ([301, 302, 303, 307, 308].includes(response.status) && location) {
			await response.body?.cancel();
			current = new URL(location, target.url).toString();
			continue;
		}
		return { response, finalUrl: target.url };
	}
	throw new BlockedUrlError(`too many redirects (>${maxRedirects})`);
}

async function runAction(
	page: import("playwright-core").Page,
	action: Record<string, unknown>,
	cfg: BrowseConfig,
): Promise<string> {
	const type = action.type as string;
	switch (type) {
		case "goto": {
			const { url } = await assertUrlAllowed(String(action.url), cfg);
			await page.goto(url, { waitUntil: "domcontentloaded" });
			return `goto ${url}`;
		}
		case "click": {
			const selector = action.selector as string | undefined;
			const text = action.text as string | undefined;
			if (selector) await page.locator(selector).first().click();
			else if (text) await page.getByText(text, { exact: false }).first().click();
			else throw new Error("click needs selector or text");
			return `click ${selector ?? text}`;
		}
		case "type": {
			const locator = page.locator(String(action.selector)).first();
			await locator.fill(String(action.text));
			if (action.submit) await locator.press("Enter");
			return `type ${action.selector}${action.submit ? " + Enter" : ""}`;
		}
		case "press": {
			const key = String(action.key);
			const selector = action.selector as string | undefined;
			if (selector) await page.locator(selector).first().press(key);
			else await page.keyboard.press(key);
			return `press ${key}`;
		}
		case "select": {
			await page.locator(String(action.selector)).first().selectOption(String(action.value));
			return `select ${action.selector} = ${action.value}`;
		}
		case "scroll": {
			if (action.selector) {
				await page.locator(String(action.selector)).first().scrollIntoViewIfNeeded();
				return `scroll to ${action.selector}`;
			}
			const y = Number(action.y ?? 800);
			await page.mouse.wheel(0, y);
			return `scroll ${y}px`;
		}
		case "wait": {
			if (action.selector) {
				await page.waitForSelector(String(action.selector));
				return `wait for ${action.selector}`;
			}
			const ms = Math.min(Number(action.ms ?? 1000), 15000);
			await page.waitForTimeout(ms);
			return `wait ${ms}ms`;
		}
		case "back":
			await page.goBack({ waitUntil: "domcontentloaded" });
			return "back";
		case "forward":
			await page.goForward({ waitUntil: "domcontentloaded" });
			return "forward";
		case "reload":
			await page.reload({ waitUntil: "domcontentloaded" });
			return "reload";
		case "eval": {
			// eslint-disable-next-line no-eval
			const value = await page.evaluate(String(action.expression));
			return `eval → ${JSON.stringify(value)?.slice(0, 500) ?? "undefined"}`;
		}
		default:
			throw new Error(`unknown action: ${type}`);
	}
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "browse",
		label: "Browse",
		description:
			"Open a URL in a real headless Chromium and return clean content. Renders JavaScript, so it works on SPAs and client-side pages. Modes: readable (Markdown article, default), text, html, links, metadata. Use waitFor to wait for a selector. Reuses one persistent browser tab, so logins and cookies carry over between calls.",
		promptSnippet:
			"browse(url) opens any page in a real browser and returns readable Markdown — use it for JS-heavy sites and any single-page read.",
		promptGuidelines: [
			"Prefer browse over guessing page content; it renders JavaScript and returns clean Markdown.",
			"For simple APIs or raw files use fetch_url — it is faster and needs no browser.",
			"When content is missing, retry with waitFor set to the selector that holds the content.",
		],
		parameters: BrowseParams,
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const cfg = deps.getConfig();
			const started = Date.now();
			let page: import("playwright-core").Page | undefined;
			let owned = false;
			try {
				const target = await assertUrlAllowed(params.url, cfg);
				const timeout = params.timeoutMs ?? cfg.timeoutMs;
				page = params.fresh ? await deps.browser.newPage() : await deps.browser.page();
				owned = Boolean(params.fresh);
				const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout });
				if (params.waitFor) await page.waitForSelector(params.waitFor, { timeout });
				if (params.waitMs) await page.waitForTimeout(Math.min(params.waitMs, 15000));
				await settle(page, Math.min(4000, timeout));

				const mode = (params.mode ?? "readable") as BrowseMode;
				const { result, output, truncated, finalUrl } = await readPage(
					deps,
					page,
					mode,
					params.selector,
				);
				return {
					content: [{ type: "text", text: output }],
					details: {
						url: target.url,
						finalUrl,
						title: result.title,
						mode,
						chars: output.length,
						truncated,
						status: response?.status() ?? null,
						elapsedMs: Date.now() - started,
						selector: params.selector,
						tabs: deps.browser.tabCount(),
					} satisfies BrowseDetails,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `browse failed: ${errorMessage(err)}` }],
					details: {
						url: params.url,
						finalUrl: page?.url() ?? params.url,
						title: "",
						mode: params.mode ?? "readable",
						chars: 0,
						truncated: false,
						status: null,
						elapsedMs: Date.now() - started,
						selector: params.selector,
						tabs: deps.browser.tabCount(),
					} satisfies BrowseDetails,
					isError: true,
				};
			} finally {
				if (owned && page && !page.isClosed()) await page.close().catch(() => {});
			}
		},
	});

	pi.registerTool({
		name: "browse_act",
		label: "Browse + Act",
		description:
			"Drive the live browser: click, type, select, scroll, press keys, navigate, go back/forward, wait, and eval JavaScript — then extract the resulting page. Use for logins, search boxes, pagination, and multi-step flows. Calls share one persistent tab, so state carries across calls.",
		promptSnippet:
			"browse_act(actions=[...]) drives a real browser through clicks/typing/scroll and returns the final page.",
		promptGuidelines: [
			"Chain related steps in one browse_act call instead of many browse calls — the page state persists between actions.",
			"Use { type: 'wait', selector } after a click that loads content asynchronously.",
		],
		parameters: ActParams,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const cfg = deps.getConfig();
			const started = Date.now();
			const outcomes: string[] = [];
			let failed = false;
			let page: import("playwright-core").Page | undefined;
			try {
				page = await deps.browser.page();
				const timeout = params.timeoutMs ?? cfg.timeoutMs;
				page.setDefaultTimeout(timeout);
				page.setDefaultNavigationTimeout(timeout);
				if (params.url) {
					const target = await assertUrlAllowed(params.url, cfg);
					await page.goto(target.url, { waitUntil: "domcontentloaded", timeout });
				}
				for (const action of params.actions as Array<Record<string, unknown>>) {
					try {
						outcomes.push(await runAction(page, action, cfg));
					} catch (err) {
						failed = true;
						outcomes.push(`✗ ${action.type}: ${errorMessage(err)}`);
						break;
					}
				}
				await settle(page, Math.min(4000, timeout));
				const mode = (params.mode ?? "readable") as BrowseMode;
				const { result, output, truncated, finalUrl } = await readPage(
					deps,
					page,
					mode,
					params.selector,
				);
				const log = outcomes.map((line) => `- ${line}`).join("\n");
				return {
					content: [{ type: "text", text: `Actions:\n${log}\n\n---\n\n${output}` }],
					isError: failed,
					details: {
						url: params.url ?? finalUrl,
						finalUrl,
						title: result.title,
						mode,
						chars: output.length,
						truncated,
						status: null,
						elapsedMs: Date.now() - started,
						selector: params.selector,
						tabs: deps.browser.tabCount(),
						actions: outcomes,
					} satisfies ActDetails,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `browse_act failed: ${errorMessage(err)}${outcomes.length ? `\n\nActions:\n${outcomes.map((l) => `- ${l}`).join("\n")}` : ""}`,
						},
					],
					details: {
						url: params.url ?? "",
						finalUrl: "",
						title: "",
						mode: params.mode ?? "readable",
						chars: 0,
						truncated: false,
						status: null,
						elapsedMs: Date.now() - started,
						selector: params.selector,
						tabs: deps.browser.tabCount(),
						actions: outcomes,
					} satisfies ActDetails,
					isError: true,
				};
			} finally {
				page?.setDefaultTimeout(cfg.timeoutMs);
				page?.setDefaultNavigationTimeout(cfg.timeoutMs);
			}
		},
	});

	pi.registerTool({
		name: "browse_screenshot",
		label: "Screenshot",
		description:
			"Capture the current browser page (or an element, or a URL you pass) as a PNG. The image is saved under the pi browse artifacts directory and returned to the model.",
		promptSnippet:
			"browse_screenshot() captures the current page as an image for visual inspection.",
		parameters: ScreenshotParams,
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params) {
			const cfg = deps.getConfig();
			try {
				const page = await deps.browser.page();
				if (params.url) {
					const target = await assertUrlAllowed(params.url, cfg);
					await page.goto(target.url, { waitUntil: "domcontentloaded" });
					await settle(page, 3000);
				}
				const buffer = params.selector
					? await page.locator(params.selector).first().screenshot()
					: await page.screenshot({ fullPage: params.fullPage ?? false });
				await mkdir(cfg.artifactsDir, { recursive: true });
				const path = join(
					cfg.artifactsDir,
					`${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
				);
				await writeFile(path, buffer);
				const attach = params.attach !== false;
				const content: Array<
					{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
				> = [{ type: "text", text: `Screenshot saved: ${path}` }];
				if (attach)
					content.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/png" });
				return {
					content,
					details: {
						url: page.url(),
						path,
						bytes: buffer.length,
						fullPage: params.fullPage ?? false,
						selector: params.selector,
					} satisfies ScreenshotDetails,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `screenshot failed: ${errorMessage(err)}` }],
					details: {
						url: params.url ?? "",
						path: "",
						bytes: 0,
						fullPage: params.fullPage ?? false,
						selector: params.selector,
					} satisfies ScreenshotDetails,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fast plain-HTTP fetch with no browser. Detects JSON and pretty-prints it; converts HTML to readable Markdown or raw HTML. Use for APIs, JSON endpoints, and static pages where rendering is unnecessary.",
		promptSnippet:
			"fetch_url(url) is the fast path for APIs, JSON, and static pages — no browser startup.",
		parameters: FetchParams,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const cfg = deps.getConfig();
			const started = Date.now();
			try {
				const headers = new Headers({ accept: "*/*", "user-agent": cfg.userAgent ?? DEFAULT_UA });
				for (const [key, value] of Object.entries(params.headers ?? {})) headers.set(key, value);
				const timeout = AbortSignal.timeout(params.timeoutMs ?? cfg.timeoutMs);
				const { response, finalUrl } = await safeFetch(params.url, cfg, {
					headers,
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
				const body = await response.text();
				const contentType = response.headers.get("content-type") ?? "";
				const mode = params.mode ?? "auto";
				let output: string;
				if (mode === "json" || (mode === "auto" && /json/.test(contentType))) {
					try {
						output = JSON.stringify(JSON.parse(body), null, 2);
					} catch {
						output = body;
					}
				} else if (mode === "html") {
					output = body;
				} else if (mode === "text" || (mode === "auto" && !/html/.test(contentType))) {
					output = body;
				} else {
					const result = await extract(body, finalUrl, "readable");
					output = result.content ? `${headerFor(result, finalUrl)}\n\n${result.content}` : body;
				}
				const { text, truncated } = truncate(output, cfg.maxChars);
				return {
					content: [
						{
							type: "text",
							text: `HTTP ${response.status} · ${contentType || "unknown type"} · ${finalUrl}\n\n${text}`,
						},
					],
					details: {
						url: finalUrl,
						status: response.status,
						contentType,
						chars: text.length,
						truncated,
						elapsedMs: Date.now() - started,
					} satisfies FetchDetails,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `fetch_url failed: ${errorMessage(err)}` }],
					details: {
						url: params.url,
						status: 0,
						contentType: "",
						chars: 0,
						truncated: false,
						elapsedMs: Date.now() - started,
					} satisfies FetchDetails,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web without API keys, driven by the real browser (DuckDuckGo, Bing fallback). Returns ranked titles, URLs, and snippets. Follow up with browse on the URLs that matter.",
		promptSnippet:
			"web_search(query) returns ranked web results with URLs and snippets — keyless and always available.",
		promptGuidelines: [
			"After web_search, read the most relevant URLs with browse instead of assuming their content.",
		],
		parameters: SearchParams,
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params) {
			const started = Date.now();
			let page: import("playwright-core").Page | undefined;
			try {
				page = await deps.browser.newPage();
				const outcome = await search(page, params.query, {
					limit: params.numResults,
					site: params.site,
					provider: params.provider as SearchProvider | undefined,
				});
				return {
					content: [
						{
							type: "text",
							text: `Search (${outcome.provider}) for "${params.query}":\n\n${formatResults(outcome)}`,
						},
					],
					details: {
						query: params.query,
						provider: outcome.provider as string,
						count: outcome.results.length,
						elapsedMs: Date.now() - started,
						results: outcome.results,
					} satisfies SearchDetails,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `web_search failed: ${errorMessage(err)}` }],
					details: {
						query: params.query,
						provider: "none",
						count: 0,
						elapsedMs: Date.now() - started,
						results: [],
					} satisfies SearchDetails,
					isError: true,
				};
			} finally {
				if (page && !page.isClosed()) await page.close().catch(() => {});
			}
		},
	});
}
