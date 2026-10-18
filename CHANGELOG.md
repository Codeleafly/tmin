# CHANGELOG.md — user-visible changes

## 0.1.0 — initial release

### Server
- Public gateway with segment-aware path routing: `/<username>`, `/<username>/2`, `/<username>/3` (permanent, account-owned).
- WebSocket tunnel control plane (`/tunnel`, outbound-only) with versioned, runtime-validated protocol frames, heartbeats, timeouts, cancellation, per-tunnel concurrency limits.
- HTTP + WebSocket forwarding: all standard methods, streaming bodies (48 KB chunks), cookies/redirects/status codes preserved, bounded buffers, backpressure.
- Accounts: registration, login (HttpOnly cookies), password change/reset, revocation; scrypt password hashing.
- API tokens: created once-visible, SHA-256 hashed at rest, optional expiry, revocable instantly.
- Anonymous tunnels: 1800-second server-enforced expiry, resume without extension, per-IP caps, sweeper + restart recovery.
- Free plan: 3 concurrent tunnels (`TUNNEL_LIMIT_REACHED`), transactional slot allocation, 1 GB/day upload + download quotas by default (configurable), usage warnings and explicit quota errors.
- Admin: env bootstrap (first start only), user management, renames, quotas, tunnel termination, anonymous session inspection, audit logs, maintenance mode, health/metrics.
- REST API v1 + generated OpenAPI at `/openapi.json`; dashboard, admin panel, and interactive docs site included.

### CLI (`tmin`)
- `http`, `login`, `logout`, `status`, `tunnels`, `stop`, `token create|list|revoke`, `account`, `usage`, `route list|release`, `config set|show`, `doctor`, `version`, `update`, `--json` mode.
- Exponential backoff + jitter reconnect that keeps the same route; anonymous countdown display; secret-safe config (0600) and redacted output; clean Ctrl+C.
- `npm i -g .` from the repo root installs the global `tmin` command (auto-builds when needed); on Termux (no `/usr/bin/env`) install hooks create sh wrappers so it works in any shell.

### Operations
- Caddy TLS reverse-proxy example (`deployment/Caddyfile`); `.env.example` with every knob documented; CI workflow; smoke script.
- 50 automated tests (unit, integration, e2e with real sockets, security, CLI subprocess, OpenAPI sync).

### Networking (unreleased)
- Bind address is now explicit: `HOST` env (default `0.0.0.0` — all interfaces) is passed to `server.listen`, so the server is reachable from LAN/reverse proxies/proxied platforms by default; `HOST=127.0.0.1` restricts it. Documented in `.env.example`.
- On platforms that inject a public domain, `PUBLIC_DOMAIN`/`PUBLIC_BASE_URL` are auto-derived from `REPLIT_DOMAINS` (or `REPLIT_DEV_DOMAIN`) when not set explicitly, so generated tunnel URLs use the platform URL (e.g. `https://<app>.replit.app`) instead of `localhost`. Explicit env always wins.

### Replit deployment (unreleased)
- Replit import config (`.replit`, `replit.nix`): importing the repo sets up the Run button (Node 20 module, install + build, server on port 8080 mapped to 80, `TRUST_PROXY=true` because traffic arrives through Replit's proxy) and the Publish command (`npm install && npm run build` / `TRUST_PROXY=true npm start`). Public URLs derive from `REPLIT_DOMAINS`. Provided as-is; not executed on Replit in the authoring environment.

### Fixes (unreleased)
- Dashboard tunnel list and admin user list inline scripts had syntax errors (Stop/Suspend buttons and the whole page script never ran). Both are fixed and covered by a page-script parse test.
- HTML pages are now served with `content-type: text/html`, `no-store` and a restrictive Content-Security-Policy via the shared `sendHtml` helper.
- Expired anonymous URLs now answer `410 Gone` with code `ANON_EXPIRED` (docs always said 410; the server used to return 404). Unknown anonymous paths stay 404.
- `MAINTENANCE_MODE=true` env now actually enables maintenance mode at boot (previously only the admin toggle worked).
- `ANONYMOUS_ABUSE_BLOCK_SECONDS` is now enforced: an IP that hits the anonymous per-IP limit is refused for the cooldown window.
- `x-forwarded-proto` forwarded to local apps reflects the real hop (`http` unless `TRUST_PROXY=true` with an inbound header) instead of a hardcoded `https`; `x-forwarded-for` respects `TRUST_PROXY`.
- WebSocket bridge: a tunnel-side failure now closes the pending public socket instead of leaving it open until the lifetime cap.
- `quotaRemaining` handles mixed limits correctly (unlimited upload no longer hides a finite download limit and vice versa).
- `ready` is now a reserved username/system prefix (`/ready` can never be shadowed by a tunnel).
- Heartbeat frames with `NaN`/`Infinity` timestamps are rejected by protocol validation.
- Stale anonymous resume secrets are pruned instead of growing forever; resume-token map entries for other servers are no longer overwritten by the CLI.
- CLI `--help --json` lists all commands; `tmin login` records the canonical username from the server; anonymous TTL messages no longer hardcode 30 minutes.

### Web console + device-flow login (unreleased)
- New static web console in `web/` (Tailwind CDN + plain JS, mobile-first, dark theme): landing
  (`/`), login (`/login`), register (`/register`), dashboard (`/dashboard` — tunnels, usage,
  API tokens with one-time secret dialog, sessions, password change), admin (`/admin` — users,
  tunnels, anonymous sessions, quotas, audit log, maintenance), device approval (`/device`) and
  docs (`/docs`). Served by the server; template placeholders inject the public base URL,
  anonymous TTL and version. No build step; assets live in `web/assets/`.
- CLI `tmin login` now defaults to an OAuth-style device flow: the CLI prints a short code
  (`XXXX-XXXX`), you approve it in the browser at `/device`, and the CLI stores a revocable
  token. `tmin login --token <secret>` uses an existing token (e.g. created in the dashboard);
  `tmin login --password` keeps the previous interactive prompt. `--no-browser` prints the URL
  without trying to open one.
- New API endpoints: `POST /api/v1/auth/device/authorize`, `POST /api/v1/auth/device/token`
  (poll; `AUTHORIZATION_PENDING`/`SLOW_DOWN`/`ACCESS_DENIED`/`DEVICE_CODE_EXPIRED`), and
  `POST /api/v1/auth/device/verify` (`check|approve|deny`, session-authenticated). Codes expire
  after 600s, are single-use, stored only as hashes, and mint exactly one bearer token; approvals
  and denials are audited.
- `device` and `register` are reserved system routes (no tunnel can shadow them).
- The npm package now ships `web/`.
- The gateway's "Route offline" 502 page is now `web/offline.html` (Tailwind-styled, mobile-responsive)
  served through the static layer with the route path HTML-escaped. No HTML strings are generated
  inside `apps/server` anymore; if `web/` is unavailable the route falls back to a JSON
  `ROUTE_OFFLINE` error.

### Known at release
- Single-server mode only; custom domains, per-route access policies, request inspector, email delivery, TCP tunnels: planned (see PLAN.md Milestone H).
- Deployment examples (Caddy config, CI) are provided as-is; the Caddyfile was not executed in the authoring environment.
