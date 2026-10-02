import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SsrfConfig {
	/**
	 * CIDR ranges exempted from the private-range guard. Needed when a local proxy
	 * uses fake-IP DNS (Clash/Surge map everything to 198.18.0.0/15).
	 */
	allowRanges: string[];
}

export interface BrowseConfig {
	/** Run Chromium headless. false opens a real window (useful for logging in). */
	headless: boolean;
	/** Explicit Chromium executable. Otherwise playwright-core resolves the cached build. */
	executablePath?: string;
	/** Persistent profile dir; cookies and localStorage survive across pi sessions. */
	profileDir: string;
	/** Close the browser after this many idle ms. 0 disables idle close. */
	idleCloseMs: number;
	/** Default navigation and action timeout. */
	timeoutMs: number;
	/** Max characters returned to the model per browse call. */
	maxChars: number;
	/** Proxy for all browser traffic, e.g. http://host:port or socks5://host:port. */
	proxy?: string;
	/** Locale sent as Accept-Language and exposed as navigator.language. */
	locale: string;
	/** Override the Chromium user agent. */
	userAgent?: string;
	/** Where screenshots land. */
	artifactsDir: string;
	ssrf: SsrfConfig;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-browse.json");

const DEFAULTS: BrowseConfig = {
	headless: true,
	profileDir: join(homedir(), ".pi", "agent", "browse-profile"),
	idleCloseMs: 5 * 60_000,
	timeoutMs: 30_000,
	maxChars: 50_000,
	locale: "en-US",
	artifactsDir: join(homedir(), ".pi", "agent", "browse-artifacts"),
	ssrf: { allowRanges: [] },
};

function envBool(name: string): boolean | undefined {
	const v = process.env[name];
	if (v === undefined) return undefined;
	return !(v === "0" || v.toLowerCase() === "false");
}

/**
 * Read ~/.pi/agent/pi-browse.json, overlay env vars and per-call overrides.
 * Cheap enough to call on every tool invocation, so config edits apply live.
 */
export function loadConfig(overrides: Partial<BrowseConfig> = {}): BrowseConfig {
	let file: Partial<BrowseConfig> = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error("expected a JSON object");
			}
			file = raw as Partial<BrowseConfig>;
		} catch (err) {
			throw new Error(`pi-browse: cannot parse ${CONFIG_PATH}: ${(err as Error).message}`);
		}
	}

	const env: Partial<BrowseConfig> = {};
	const headless = envBool("PI_BROWSE_HEADLESS");
	if (headless !== undefined) env.headless = headless;
	if (process.env.PI_BROWSE_CHROMIUM) env.executablePath = process.env.PI_BROWSE_CHROMIUM;
	if (process.env.PI_BROWSE_PROXY) env.proxy = process.env.PI_BROWSE_PROXY;
	if (process.env.PI_BROWSE_PROFILE) env.profileDir = process.env.PI_BROWSE_PROFILE;

	return {
		...DEFAULTS,
		...file,
		...env,
		...overrides,
		ssrf: { ...DEFAULTS.ssrf, ...(file.ssrf ?? {}), ...(overrides.ssrf ?? {}) },
	};
}
