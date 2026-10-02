import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowseConfig } from "./config";

/** Thrown when a URL targets a non-public or non-http(s) destination. */
export class BlockedUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlockedUrlError";
	}
}

export interface ResolvedTarget {
	url: string;
	hostname: string;
	addresses: string[];
}

/** IPv4 ranges that must never be reachable from an agent-driven fetch. */
const V4_BLOCKED: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local / cloud metadata
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15], // benchmark / fake-IP proxies
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved
];

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		n = (n << 8) | octet;
	}
	return n >>> 0;
}

function inV4Range(n: number, base: number, prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (n & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv6ToBigInt(input: string): bigint | null {
	let ip = input;
	const zone = ip.indexOf("%");
	if (zone !== -1) ip = ip.slice(0, zone);
	if (ip.includes(".")) {
		const lastColon = ip.lastIndexOf(":");
		if (lastColon === -1) return null;
		const v4 = ipv4ToInt(ip.slice(lastColon + 1));
		if (v4 === null) return null;
		ip = `${ip.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	let groups: string[];
	if (halves.length === 2) {
		const left = halves[0] ? halves[0].split(":") : [];
		const right = halves[1] ? halves[1].split(":") : [];
		const missing = 8 - left.length - right.length;
		if (missing < 0) return null;
		groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
	} else {
		groups = ip.split(":");
	}
	if (groups.length !== 8) return null;
	let n = 0n;
	for (const group of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		n = (n << 16n) | BigInt(parseInt(group, 16));
	}
	return n;
}

function isPrivateV4(n: number): boolean {
	return V4_BLOCKED.some(([base, prefix]) => inV4Range(n, ipv4ToInt(base)!, prefix));
}

function isPrivateV6(n: bigint): boolean {
	if (n === 0n || n === 1n) return true; // ::, ::1
	const top8 = n >> 120n;
	if (top8 === 0xffn) return true; // ff00::/8 multicast
	const top10 = n >> 118n;
	if (top10 === 0x3fan || top10 === 0x3fbn) return true; // fe80::/10, fec0::/10
	if ((top8 & 0xfen) === 0xfcn) return true; // fc00::/7 ULA
	const high32 = n >> 32n;
	if (high32 === 0xffffn) return isPrivateV4(Number(n & 0xffffffffn)); // ::ffff:0:0/96
	if (high32 === 0x64ff9bn) return isPrivateV4(Number(n & 0xffffffffn)); // 64:ff9b::/96 NAT64
	if (n >> 112n === 0x2002n) return isPrivateV4(Number((n >> 80n) & 0xffffffffn)); // 2002::/16 6to4
	return false;
}

function isPrivateIp(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return isPrivateV4(ipv4ToInt(ip)!);
	if (family === 6) {
		const n = ipv6ToBigInt(ip);
		return n === null ? true : isPrivateV6(n);
	}
	return true;
}

function ipInCidr(ip: string, cidr: string): boolean {
	const slash = cidr.indexOf("/");
	if (slash === -1) return ip === cidr;
	const base = cidr.slice(0, slash);
	const rawPrefix = cidr.slice(slash + 1);
	const prefix = Number(rawPrefix);
	const family = isIP(ip);
	if (
		!/^\d+$/.test(rawPrefix) ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > (family === 4 ? 32 : 128) ||
		isIP(base) !== family
	)
		return false;
	if (family === 4) {
		const n = ipv4ToInt(ip);
		const b = ipv4ToInt(base);
		if (n === null || b === null) return false;
		return inV4Range(n, b, prefix);
	}
	if (family === 6) {
		const n = ipv6ToBigInt(ip);
		const b = ipv6ToBigInt(base);
		if (n === null || b === null) return false;
		const mask = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n);
		return (n & mask) === (b & mask);
	}
	return false;
}

/**
 * Resolve a URL and refuse private, loopback, link-local, and metadata
 * destinations. This checks a DNS snapshot, not the eventual socket peer:
 * a network-level egress policy is still needed to prevent DNS rebinding.
 */
export async function assertUrlAllowed(raw: string, cfg: BrowseConfig): Promise<ResolvedTarget> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BlockedUrlError(`not a valid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError(`only http(s) URLs are allowed, got ${url.protocol}`);
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const allow = cfg.ssrf.allowRanges;
	const exempt = (ip: string) => allow.some((cidr) => ipInCidr(ip, cidr));

	if (isIP(hostname)) {
		if (isPrivateIp(hostname) && !exempt(hostname)) {
			throw new BlockedUrlError(`refusing private address ${hostname}`);
		}
		return { url: url.toString(), hostname, addresses: [hostname] };
	}

	let records: Array<{ address: string; family: number }>;
	try {
		records = await lookup(hostname, { all: true, verbatim: true });
	} catch (err) {
		throw new BlockedUrlError(`cannot resolve ${hostname}: ${(err as Error).message}`);
	}
	if (records.length === 0) throw new BlockedUrlError(`cannot resolve ${hostname}`);

	const addresses = records.map((r) => r.address);
	const blocked = addresses.find((a) => isPrivateIp(a) && !exempt(a));
	if (blocked) {
		throw new BlockedUrlError(
			`${hostname} resolves to private address ${blocked}; add it to ssrf.allowRanges in ${"~/.pi/agent/pi-browse.json"} if this is intentional`,
		);
	}
	return { url: url.toString(), hostname, addresses };
}
