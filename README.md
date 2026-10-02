# pi-browse

Browser-first web access for [pi](https://pi.dev). Real Chromium, persistent
sessions, multi-step interaction, clean extraction — and keyless search.

Built to replace `pi-web-access` with depth instead of a provider zoo: one
browser that renders JavaScript and remembers who you are, rather than thirty
HTTP adapters that only ever see the pre-render HTML.

## Why

Most "read the web" tools fetch HTML over HTTP. That works until the page is a
SPA, behind a bot check, or only useful after a login — which is most of the
modern web. `pi-browse` drives an actual Chromium:

|                                             | plain HTTP fetch | `pi-browse`                           |
| ------------------------------------------- | ---------------- | ------------------------------------- |
| JavaScript-rendered content                 | empty shell      | rendered                              |
| Login / cookies                             | none             | persistent profile, survives restarts |
| Multi-step flows (search, paginate, filter) | impossible       | `browse_act`                          |
| Screenshots / visual checks                 | no               | `browse_screenshot`                   |
| Cost                                        | ~1 request       | browser startup (amortized)           |

## Install

```bash
pi install git:github.com/dvictor357/pi-browse
# or a local checkout:
pi install /path/to/pi-browse
```

Requires a Chromium build for Playwright:

```bash
npx playwright@1.63.0 install chromium
```

`pi-browse` pins `playwright-core@1.63.0` (Chromium r1243). If a browser is
already cached under `~/Library/Caches/ms-playwright`, it is used as-is.

## Tools

| Tool                | What it does                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browse`            | Open a URL, render it, return Markdown. Modes: `readable` (default), `text`, `html`, `links`, `metadata`.                                       |
| `browse_act`        | Drive the live page: `goto`, `click`, `type`, `press`, `select`, `scroll`, `wait`, `back`/`forward`/`reload`, `eval` — then extract the result. |
| `browse_screenshot` | Capture the page or an element as a PNG and return it to the model.                                                                             |
| `fetch_url`         | Fast plain-HTTP path for APIs, JSON, and static pages. No browser.                                                                              |
| `web_search`        | Keyless search via DuckDuckGo (Bing fallback). Returns titles, URLs, snippets.                                                                  |

All tools reuse one persistent browser tab, so a `browse` followed by a
`browse_act` continues in the same session.

## Commands

| Command         | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `/browse <url>` | Open a URL and report its title.                                           |
| `/browse-mode`  | Toggle headless ↔ headed. Use headed to log in once; the profile persists. |
| `/browse-close` | Close the browser.                                                         |

## Configuration

`~/.pi/agent/pi-browse.json` (all fields optional):

```json
{
  "headless": true,
  "profileDir": "~/.pi/agent/browse-profile",
  "idleCloseMs": 300000,
  "timeoutMs": 30000,
  "maxChars": 50000,
  "locale": "en-US",
  "proxy": "socks5://127.0.0.1:1080",
  "executablePath": "/path/to/chrome-headless-shell",
  "userAgent": "Mozilla/5.0 …",
  "artifactsDir": "~/.pi/agent/browse-artifacts",
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

Environment overrides: `PI_BROWSE_HEADLESS`, `PI_BROWSE_CHROMIUM`,
`PI_BROWSE_PROXY`, `PI_BROWSE_PROFILE`.

### `ssrf.allowRanges`

HTTP(S) requests are resolved and checked against private, loopback, link-local,
and cloud-metadata ranges. Chromium request interception checks redirects,
subresources, and action-driven navigation; WebSocket destinations are checked
as well. Service workers are blocked so they cannot bypass interception.
`fetch_url` checks each redirect hop and honors its timeout and cancellation.

If you run a local proxy that uses fake-IP DNS (Clash, Surge), everything
resolves to `198.18.0.0/15` and gets blocked — add that range to `allowRanges`
to permit it. Malformed CIDR exceptions do not grant access.

This is **not a network sandbox**: DNS checks do not pin the actual socket peer,
and a popup's first request can race interceptor attachment. Non-HTTP browser
traffic is not fully contained. Use a network-level egress policy when browsing
hostile sites.

## Persistence

The browser uses a persistent profile at `profileDir`. Cookies, `localStorage`,
and logins survive across tool calls and pi restarts. Run `/browse-mode` to go
headed, log in, then run it again to return to headless.

## Development

```bash
npm install
npm run typecheck
npm test          # unit regressions: SSRF, extraction, tools, lifecycle
npx tsx test/browser-smoke.ts  # local Chromium: rendering + private-request blocking
npx tsx test/smoke.ts          # live: browser rendering, search, fetch (needs network)
```

## Limitations

Honest scope for v1:

- Single browser, serialized use. No parallel-tab fan-out yet.
- `web_search` uses DuckDuckGo/Bing HTML, which can rate-limit under heavy use.
- No PDF/YouTube/GitHub-specific extractors (yet) — `browse` handles their HTML
  pages, but not PDF text or video transcripts.
- No on-disk content cache; every call re-fetches.
