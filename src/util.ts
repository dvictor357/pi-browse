import type { Page } from "playwright-core";

export interface Truncated {
	text: string;
	truncated: boolean;
}

/** Clip model-facing text, keeping head and tail so endings are visible. */
export function truncate(text: string, maxChars: number): Truncated {
	if (text.length <= maxChars) return { text, truncated: false };
	const head = Math.floor(maxChars * 0.8);
	const tail = maxChars - head;
	return {
		text: `${text.slice(0, head)}\n\n… [${text.length - maxChars} chars trimmed] …\n\n${text.slice(-tail)}`,
		truncated: true,
	};
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Let client-rendered pages finish. Playwright's "networkidle" never fires on
 * pages that poll or stream, and "load" fires before hydration, so wait for the
 * network to quiet down and then for the DOM to stop mutating.
 */
export async function settle(page: Page, budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	try {
		await page.waitForLoadState("networkidle", { timeout: Math.min(2500, budgetMs) });
	} catch {
		// Polling/streaming pages never reach networkidle; the DOM check below covers them.
	}
	const remaining = deadline - Date.now();
	if (remaining <= 0) return;
	try {
		// Passed as a string, not a function: bundlers inject helpers (esbuild's
		// __name) that do not exist in the page when Playwright serializes a function.
		await page.evaluate(`new Promise((resolve) => {
			let last = Date.now();
			const observer = new MutationObserver(() => { last = Date.now(); });
			observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
			const deadline = ${deadline};
			const tick = () => {
				if (Date.now() - last > 500 || Date.now() > deadline) { observer.disconnect(); resolve(); }
				else setTimeout(tick, 100);
			};
			tick();
		})`);
	} catch {
		// Navigation during settle invalidates the evaluation; treated as settled.
	}
}

export function parseProxy(
	value: string,
): { server: string; username?: string; password?: string } | undefined {
	try {
		const url = new URL(value);
		const auth = url.username
			? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
			: {};
		url.username = "";
		url.password = "";
		return { server: url.toString().replace(/\/$/, ""), ...auth };
	} catch {
		return undefined;
	}
}
