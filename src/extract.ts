import { Defuddle, type DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";

export type BrowseMode = "readable" | "text" | "html" | "links" | "metadata";

export interface ExtractedLink {
	text: string;
	url: string;
}

export interface ExtractResult {
	mode: BrowseMode;
	title: string;
	byline: string;
	published: string;
	site: string;
	excerpt: string;
	wordCount: number;
	content: string;
	links?: ExtractedLink[];
}

function emptyResult(mode: BrowseMode): ExtractResult {
	return {
		mode,
		title: "",
		byline: "",
		published: "",
		site: "",
		excerpt: "",
		wordCount: 0,
		content: "",
	};
}

function htmlToText(html: string): string {
	if (!html) return "";
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const body = document.body;
	if (!body) return "";
	const junk = body.querySelectorAll("script,style,noscript,svg,template");
	for (let i = 0; i < junk.length; i++) junk[i].remove();
	return (body.textContent ?? "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function collectLinks(html: string, baseUrl: string, limit = 300): ExtractedLink[] {
	const { document } = parseHTML(html);
	const seen = new Set<string>();
	const links: ExtractedLink[] = [];
	const anchors = document.querySelectorAll("a[href]");
	for (let i = 0; i < anchors.length; i++) {
		const anchor = anchors[i];
		const href = anchor.getAttribute("href");
		if (!href) continue;
		let resolved: string;
		try {
			resolved = new URL(href, baseUrl).toString();
		} catch {
			continue;
		}
		const key = resolved.split("#")[0];
		if (seen.has(key)) continue;
		seen.add(key);
		links.push({
			text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
			url: resolved,
		});
		if (links.length >= limit) break;
	}
	return links;
}

function applyMetadata(target: ExtractResult, response: DefuddleResponse): void {
	target.title = response.title ?? "";
	target.byline = response.author ?? "";
	target.published = response.published ?? "";
	target.site = response.site || response.domain || "";
	target.excerpt = response.description ?? "";
	target.wordCount = response.wordCount ?? 0;
}

/**
 * Turn a page's HTML into model-friendly content.
 *
 * - readable: main article as Markdown (Defuddle readability heuristics)
 * - text: article body as plain text
 * - html: raw page HTML (truncated by the caller)
 * - links: every link on the page as a Markdown list
 * - metadata: title/author/site/date only, no body
 *
 * `selector` scopes extraction to one element's subtree.
 */
export async function extract(
	html: string,
	url: string,
	mode: BrowseMode = "readable",
	selector?: string,
): Promise<ExtractResult> {
	if (!html || !html.trim()) return emptyResult(mode);

	if (mode === "links") {
		const result = emptyResult(mode);
		result.links = collectLinks(html, url);
		result.content = result.links
			.map((link) => `- [${link.text || link.url}](${link.url})`)
			.join("\n");
		return result;
	}

	if (mode === "html" && !selector) {
		const result = emptyResult(mode);
		result.content = html;
		return result;
	}

	let source = html;
	if (selector) {
		const { document } = parseHTML(html);
		const element = document.querySelector(selector);
		if (!element) throw new Error(`selector not found: ${selector}`);
		source = `<html><body>${element.innerHTML ?? ""}</body></html>`;
		if (mode === "html") {
			const result = emptyResult(mode);
			result.content = source;
			return result;
		}
	}

	if (mode === "text") {
		const response = await Defuddle(source, url, { markdown: false });
		const result = emptyResult(mode);
		applyMetadata(result, response);
		result.content = htmlToText(response.content ?? "");
		return result;
	}

	const response = await Defuddle(source, url, { markdown: mode !== "metadata" });
	const result = emptyResult(mode);
	applyMetadata(result, response);
	if (mode === "metadata") {
		result.content = "";
	} else {
		result.content = response.contentMarkdown ?? response.content ?? "";
	}
	return result;
}
