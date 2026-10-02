import type { Page } from "playwright-core";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchOutcome {
	provider: "duckduckgo" | "bing";
	results: SearchResult[];
}

export type SearchProvider = "auto" | "duckduckgo" | "bing";

function clean(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

/** DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<encoded>. */
function decodeDuckDuckGo(href: string): string {
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const parsed = new URL(absolute);
		if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
			return parsed.searchParams.get("uddg") ?? absolute;
		}
		return absolute;
	} catch {
		return absolute;
	}
}

/** Bing wraps results as bing.com/ck/a?...&u=a1<base64url>. */
function decodeBing(href: string): string {
	try {
		const parsed = new URL(href, "https://www.bing.com");
		if (parsed.hostname.endsWith("bing.com") && parsed.pathname.startsWith("/ck/a")) {
			const u = parsed.searchParams.get("u");
			if (u?.startsWith("a1")) {
				const decoded = Buffer.from(
					u.slice(2).replace(/-/g, "+").replace(/_/g, "/"),
					"base64",
				).toString("utf8");
				if (/^https?:\/\//.test(decoded)) return decoded;
			}
		}
		return parsed.toString();
	} catch {
		return href;
	}
}

function isAd(url: string): boolean {
	return (
		/duckduckgo\.com\/(y\.js|l\/)/.test(url) ||
		url.includes("ad_provider=") ||
		url.includes("bing.com/aclick")
	);
}

async function duckduckgo(page: Page, query: string, limit: number): Promise<SearchResult[]> {
	await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
		waitUntil: "domcontentloaded",
		timeout: 20000,
	});
	await page.waitForSelector(".result, .no-results", { timeout: 10000 }).catch(() => {});
	const nodes = page.locator(".result");
	const total = Math.min(await nodes.count(), limit * 3);
	const results: SearchResult[] = [];
	for (let i = 0; i < total && results.length < limit; i++) {
		const item = nodes.nth(i);
		if (((await item.getAttribute("class")) ?? "").includes("result--ad")) continue;
		const anchor = item.locator(".result__a").first();
		if ((await anchor.count()) === 0) continue;
		const href = await anchor.getAttribute("href");
		if (!href) continue;
		const url = decodeDuckDuckGo(href);
		if (isAd(url)) continue;
		results.push({
			title: clean(await anchor.textContent()),
			url,
			snippet: clean(
				await item
					.locator(".result__snippet")
					.first()
					.textContent()
					.catch(() => ""),
			),
		});
	}
	return results;
}

async function bing(page: Page, query: string, limit: number): Promise<SearchResult[]> {
	await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
		waitUntil: "domcontentloaded",
		timeout: 20000,
	});
	await page.waitForSelector("li.b_algo", { timeout: 10000 }).catch(() => {});
	const nodes = page.locator("li.b_algo");
	const total = Math.min(await nodes.count(), limit);
	const results: SearchResult[] = [];
	for (let i = 0; i < total; i++) {
		const item = nodes.nth(i);
		const anchor = item.locator("h2 a").first();
		if ((await anchor.count()) === 0) continue;
		const href = await anchor.getAttribute("href");
		if (!href) continue;
		results.push({
			title: clean(await anchor.textContent()),
			url: decodeBing(href),
			snippet: clean(
				await item
					.locator(".b_caption p, .b_lineclamp2, p")
					.first()
					.textContent()
					.catch(() => ""),
			),
		});
	}
	return results;
}

/**
 * Keyless web search driven by the real browser. DuckDuckGo's HTML endpoint is
 * tried first; Bing is the fallback. No API keys, no per-provider zoo.
 */
export async function search(
	page: Page,
	query: string,
	opts: { limit?: number; site?: string; provider?: SearchProvider } = {},
): Promise<SearchOutcome> {
	const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
	const scoped = opts.site ? `${query} site:${opts.site}` : query;
	const provider = opts.provider ?? "auto";

	if (provider === "duckduckgo" || provider === "auto") {
		const results = await duckduckgo(page, scoped, limit);
		if (results.length > 0 || provider === "duckduckgo") return { provider: "duckduckgo", results };
	}
	return { provider: "bing", results: await bing(page, scoped, limit) };
}

export function formatResults(outcome: SearchOutcome): string {
	if (outcome.results.length === 0) return "No results.";
	return outcome.results
		.map((r, i) => `${i + 1}. [${r.title}](${r.url})${r.snippet ? `\n   ${r.snippet}` : ""}`)
		.join("\n\n");
}
