import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config";
import { assertUrlAllowed, BlockedUrlError } from "../src/ssrf";

const cfg = loadConfig();

test("blocks non-http protocols", async () => {
	await assert.rejects(() => assertUrlAllowed("file:///etc/passwd", cfg), BlockedUrlError);
	await assert.rejects(() => assertUrlAllowed("ftp://example.com/x", cfg), BlockedUrlError);
});

test("blocks loopback and private IPv4 literals", async () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"192.168.1.1",
		"169.254.169.254",
		"0.0.0.0",
		"172.16.5.5",
	]) {
		await assert.rejects(() => assertUrlAllowed(`http://${ip}/`, cfg), BlockedUrlError, ip);
	}
});

test("blocks private IPv6 literals", async () => {
	for (const ip of ["[::1]", "[::]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
		await assert.rejects(() => assertUrlAllowed(`http://${ip}/`, cfg), BlockedUrlError, ip);
	}
});

test("blocks localhost hostname", async () => {
	await assert.rejects(() => assertUrlAllowed("http://localhost:8080/", cfg), BlockedUrlError);
});

test("allows public IP literals", async () => {
	const target = await assertUrlAllowed("https://1.1.1.1/", cfg);
	assert.equal(target.hostname, "1.1.1.1");
});

test("ssrf.allowRanges exempts a range", async () => {
	const relaxed = loadConfig({ ssrf: { allowRanges: ["198.18.0.0/15", "127.0.0.0/8"] } });
	const target = await assertUrlAllowed("http://198.18.5.5/", relaxed);
	assert.equal(target.hostname, "198.18.5.5");
	await assertUrlAllowed("http://127.0.0.1/", relaxed);
});

test("malformed allowRanges cannot bypass private-address checks", async () => {
	for (const cidr of ["127.0.0.0/33", "127.0.0.0/-1", "127.0.0.0/", "127.0.0.0/1.5", "::1/129"]) {
		const config = loadConfig({ ssrf: { allowRanges: [cidr] } });
		await assert.rejects(
			() => assertUrlAllowed("http://127.0.0.1/", config),
			BlockedUrlError,
			cidr,
		);
		await assert.rejects(() => assertUrlAllowed("http://[::1]/", config), BlockedUrlError, cidr);
	}
});

test("invalid URLs are rejected", async () => {
	await assert.rejects(() => assertUrlAllowed("not a url", cfg), BlockedUrlError);
});
