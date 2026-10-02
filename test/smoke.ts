/**
 * Manual smoke test — not part of `npm test` (needs network + a browser).
 *
 *   npx tsx test/smoke.ts
 *
 * quotes.toscrape.com/js/ renders its quotes with JavaScript, so a plain HTTP
 * fetch sees an empty shell while the browser sees the content. That difference
 * is exactly what pi-browse exists to cover.
 */
import { BrowserManager } from "../src/browser";
import { loadConfig } from "../src/config";
import { extract } from "../src/extract";
import { formatResults, search } from "../src/search";
import { assertUrlAllowed } from "../src/ssrf";

const cfg = loadConfig();
const browser = new BrowserManager(() => cfg);
const MARKER = "process of our thinking";

async function main() {
	const target = await assertUrlAllowed("https://quotes.toscrape.com/js/", cfg);

	// 1. Plain HTTP fast path: JavaScript never runs.
	const rawHtml = await (await fetch(target.url)).text();
	const rawText = await extract(rawHtml, target.url, "text");
	const rawHasMarker = rawText.content.includes(MARKER);
	console.log(
		`plain fetch  → ${rawHasMarker ? "HAS" : "missing"} rendered text (${rawText.content.length} chars)`,
	);

	// 2. Browser path: Chromium executes the page's JavaScript.
	const page = await browser.page();
	const response = await page.goto(target.url, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".quote", { timeout: 15000 });
	const result = await extract(await page.content(), page.url(), "readable");
	const browserHasMarker = result.content.includes(MARKER);
	console.log(
		`browser      → ${browserHasMarker ? "HAS" : "missing"} rendered text (${result.content.length} chars)`,
	);
	console.log(`status ${response?.status()} · title "${result.title}"`);

	// 3. Keyless search.
	const outcome = await search(page, "pi coding agent playwright", { limit: 5 });
	console.log(`search       → ${outcome.provider}, ${outcome.results.length} results`);
	console.log(formatResults(outcome).slice(0, 200));

	await browser.close();
	const ok = !rawHasMarker && browserHasMarker && outcome.results.length > 0;
	console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
	process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
	console.error("SMOKE ERROR:", err);
	await browser.close();
	process.exit(1);
});
