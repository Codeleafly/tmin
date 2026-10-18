# TESTING.md — strategy, coverage, and how to verify

## Commands

```bash
npm run build            # required before tests (tests run from dist/)
npm run typecheck
npm run lint
npm test                 # everything (69 tests / 22 suites)
npm run test:unit        # username/route/quota/protocol/password/config rules
npm run test:integration # accounts, limits, allocation, quota persistence, recovery
npm run test:e2e         # real HTTP + WS forwarding through a real tunnel
npm run smoke            # spawns the real binary, checks public surfaces
```

Reports are plain `node --test` output; suites run from `dist/apps/server/test/*.test.js`.

## What each suite proves

**unit.test.ts (30)** — username normalization/reserved names (incl. `ready`/`device`)/`a-` namespace; segment-aware route parsing (`/myapp` vs `/myapp2` vs `/myapp/22`); quota math incl. mixed limited/unlimited pairs + warning thresholds; error→status mapping; protocol frame validation incl. oversized/bad-base64 bodies and non-finite heartbeat timestamps; scrypt roundtrip; config fail-fast (production secret, TTL bounds); **static web UI** (every page route resolves to an existing file incl. `offline.html`, viewport meta + Tailwind CDN present, referenced `/assets/*` exist, all inline + asset scripts parse via `new Function`, `{{placeholders}}` render, the offline page renders from `web/` with the route path HTML-escaped); **migrations** v3→v4 and fresh DB keep/populate `deviceAuths`.

**integration.test.ts (8)** — register/duplicate/reserved; login generic failures; tokens (list never shows secrets, revoke = instant 401); sessions; password change + reset (single-use token, old sessions revoked); **3-tunnel limit** (3 live, 4th refused `TUNNEL_LIMIT_REACHED`, frees after stop); **concurrent slot allocation** (10 parallel allocations → 1 row); route release refused while live; **quota exhaustion → 429** and persisted usage row; restart recovery marks stale rows.

**e2e.test.ts (9)** — all methods + query/headers/cookies/redirects preserved; forwarded headers reflect the real hop (`x-forwarded-proto: http`, real client IP); HEAD; 2 MiB download stream; 512 KiB upload; 20 simultaneous requests with no response mix-up; offline page + 404; **WebSocket upgrade bridged bidirectionally** (message before local accept — regression-tested); upstream timeout → 504; **anonymous** serves → resume keeps the *same* `expiresAt` → after TTL: `410 ANON_EXPIRED`, unchanged row; per-IP anon limit + abuse cooldown (`ANONYMOUS_ABUSE_BLOCK_SECONDS`) refuses new sessions even after the first ends.

**security.test.ts (7)** — cross-user route/tunnel access (404), per-user route isolation, non-admin 403 / anonymous 401; admin suspend kills tunnel + blocks login + audit row; self-demotion refused; token revoke blocks tunnel auth; reserved/lookalike usernames (incl. `Ready`); encoded-path cases; oversized API body; malformed WS frames; maintenance mode fail-closed; `MAINTENANCE_MODE=true` env boots fail-closed and is reflected in `/ready`.

**cli.test.ts (5)** — spawns the real CLI: connects (real token auth), serves traffic, **server-side socket kill → CLI reconnects to the SAME URL** (backoff), clean `SIGINT` exit; anonymous CLI exits(1) after server-side expiry with a single registration; **device-flow login end-to-end** (CLI prints the code → HTTP approval with a real session cookie → CLI stores the token and exits 0); `login --token` validates a real token; `doctor --json` passes against a healthy server.

**device.test.ts (8)** — device authorization: formatted one-time user code (never stored plaintext), 600 s TTL + 5 s interval, `AUTHORIZATION_PENDING` then `SLOW_DOWN`, unknown/missing codes `INVALID_DEVICE_CODE`, verify requires a session, check/approve mints **exactly one** working bearer token (usable on `/api/v1/me`), replay rejected, deny → `ACCESS_DENIED`, expired → `DEVICE_CODE_EXPIRED`, and `/device` is a reserved route.

**openapi.test.ts (2)** — every `ROUTE_TABLE` entry appears exactly once in the spec; **every documented route is actually served** (fixtures created; 404 means drift).

## Conventions

- Helpers (`test/helpers.ts`): `boot()` starts a real server on port 0 with a temp data dir and cleared module cache — isolated stores, registries, and usage counters per suite. `TunnelClient` speaks the real protocol (mirrors `apps/cli/src/forward.ts`).
- No mocks for networking: real sockets, real file IO, real subprocesses.
- Expiry is tested with short TTLs (`ANONYMOUS_TUNNEL_TTL_SECONDS=2`) plus a 300 ms sweeper — no 30-minute waits.
- Any failing test must be fixed, not skipped; there are no `skip`s in the suite.

## Manual verification (5 minutes)

```bash
DATA_DIR=$(mktemp -d) SESSION_SECRET="$(openssl rand -hex 32)" \
  ADMIN_PASSWORD='Adminpass1!' PORT=8080 npm start &

# terminal 2 (after: npm install && npm i -g .):
python3 -m http.server 3000 &
tmin http 3000 --anonymous   # note the /a-… URL
curl -i http://localhost:8080/a-…/   # 200 from your python server
tmin login                   # register first via /register, then approve the code at /device
tmin http 3000               # → /<username>, permanent
tmin doctor                  # ✓ dns/tls/health/auth
```

Quota check: set `FREE_DOWNLOAD_LIMIT_BYTES=100000`, download a >100 KB file twice; second request → `429 QUOTA_EXCEEDED_DOWNLOAD`; `tmin usage` shows the bytes.

## CI

`.github/workflows/ci.yml`: install → build → typecheck → lint → test → global CLI install (`npm i -g . && tmin version`) on Node 20. No services required (JSON store).

## Not covered here

Browser (Playwright) automation — the `web/` pages are static REST clients, exercised through the API tests, static-analysis checks (unit) and the smoke script; Caddy/reverse-proxy config execution; real Let's Encrypt issuance.
