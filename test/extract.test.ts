import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "../src/extract";
import { truncate } from "../src/util";

const PAGE = `<!doctype html>
<html>
<head>
	<title>Widget Benchmarks 2026</title>
	<meta name="description" content="How fast are widgets this year." />
	<meta property="og:site_name" content="Widget Weekly" />
</head>
<body>
	<nav><a href="/home">Home</a><a href="/about">About</a></nav>
	<script>window.__DATA__ = { ignored: true };</script>
	<article>
		<h1>Widget Benchmarks 2026</h1>
		<p>Widgets got <strong>substantially</strong> faster this year, according to our annual survey of twelve vendors.</p>
		<p>Latency dropped by roughly <em>twenty percent</em> across the board, while throughput held steady.</p>
		<p>Read <a href="/methodology">the methodology</a> for the full breakdown of how the numbers were gathered.</p>
	</article>
	<footer><a href="https://example.com/contact">Contact us</a></footer>
</body>
</html>`;

test("readable mode returns markdown article text", async () => {
	const result = await extract(PAGE, "https://example.com/widgets", "readable");
	assert.equal(result.title, "Widget Benchmarks 2026");
	assert.match(result.content, /substantially/);
	assert.match(result.content, /twenty percent/);
	assert.ok(!result.content.includes("__DATA__"), "script content must be stripped");
});

test("text mode strips markup", async () => {
	const result = await extract(PAGE, "https://example.com/widgets", "text");
	assert.match(result.content, /substantially/);
	assert.ok(!result.content.includes("<strong>"), "tags must be removed");
});

test("html mode returns the raw document", async () => {
	const result = await extract(PAGE, "https://example.com/widgets", "html");
	assert.ok(result.content.includes("<!doctype html>"));
});

test("links mode resolves and dedupes links", async () => {
	const result = await extract(PAGE, "https://example.com/widgets", "links");
	const urls = (result.links ?? []).map((l) => l.url);
	assert.ok(urls.includes("https://example.com/home"));
	assert.ok(urls.includes("https://example.com/methodology"));
	assert.ok(urls.includes("https://example.com/contact"));
});

test("selector scopes extraction", async () => {
	const result = await extract(PAGE, "https://example.com/widgets", "readable", "article");
	assert.match(result.content, /substantially/);
	assert.ok(!result.content.includes("Home"), "nav text must be excluded");
});

test("empty html yields empty content", async () => {
	const result = await extract("", "https://example.com/", "readable");
	assert.equal(result.content, "");
});

test("truncate keeps head and tail", () => {
	const long = "a".repeat(100) + "MIDDLE" + "z".repeat(100);
	const { text, truncated } = truncate(long, 50);
	assert.equal(truncated, true);
	assert.ok(text.startsWith("a".repeat(40)));
	assert.ok(text.endsWith("z".repeat(10)));
	assert.match(text, /trimmed/);
});
