/** Local Chromium regression checks: npx tsx test/browser-smoke.ts */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/browser";
import { loadConfig } from "../src/config";

const root = await mkdtemp(join(tmpdir(), "pi-browse-test-"));
let privateHits = 0;
const privateServer = createServer((_req, res) => {
	privateHits++;
	res.end("private content");
});
privateServer.on("upgrade", (_req, socket) => {
	privateHits++;
	socket.destroy();
});
await new Promise<void>((resolve) => privateServer.listen(0, "::1", resolve));
const privatePort = (privateServer.address() as { port: number }).port;
const blockedUrl = `http://[::1]:${privatePort}/`;
const server = createServer((req, res) => {
	if (req.url === "/redirect") {
		res.writeHead(302, { location: "/second-redirect" });
		res.end();
	} else if (req.url === "/second-redirect") {
		res.writeHead(302, { location: blockedUrl });
		res.end();
	} else {
		res.setHeader("content-type", "text/html");
		res.end(`<html><body><p id="content"></p><script>
			document.querySelector('#content').textContent = 'Rendered by JavaScript';
			fetch('${blockedUrl}').catch(() => {}).finally(() => { window.fetchDone = true; });
			const socket = new WebSocket('${blockedUrl.replace("http:", "ws:")}');
			socket.onerror = socket.onclose = () => { window.socketDone = true; };
		</script><a id="private" href="${blockedUrl}">private</a></body></html>`);
	}
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const cfg = loadConfig({
	profileDir: join(root, "profile"),
	artifactsDir: root,
	idleCloseMs: 0,
	ssrf: { allowRanges: ["127.0.0.1/32"] },
});
const browser = new BrowserManager(() => cfg);
try {
	const page = await browser.page();
	await page.goto(`http://127.0.0.1:${port}/`);
	assert.equal(await page.locator("#content").textContent(), "Rendered by JavaScript");
	await page.waitForFunction("window.fetchDone && window.socketDone");
	assert.equal(privateHits, 0, "HTTP and WebSocket subrequests must pass the URL guard");
	await assert.rejects(() => page.goto(`http://127.0.0.1:${port}/redirect`));
	assert.equal(privateHits, 0, "every redirect hop must pass the URL guard");
	const clickPage = await browser.newPage();
	await clickPage.goto(`http://127.0.0.1:${port}/`);
	await Promise.all([
		clickPage.waitForEvent("requestfailed", {
			predicate: (request) => request.url() === blockedUrl,
		}),
		clickPage.locator("#private").click(),
	]);
	assert.equal(privateHits, 0, "click navigation must pass the URL guard");
	console.log("BROWSER REGRESSIONS PASS");
} finally {
	await browser.close();
	server.closeAllConnections();
	privateServer.closeAllConnections();
	await Promise.all([
		new Promise<void>((resolve) => server.close(() => resolve())),
		new Promise<void>((resolve) => privateServer.close(() => resolve())),
	]);
	await rm(root, { recursive: true, force: true });
}
