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

### Known at release
- Single-server mode only; custom domains, per-route access policies, request inspector, email delivery, TCP tunnels: planned (see PLAN.md Milestone H).
- Deployment examples (Caddy config, CI) are provided as-is; the Caddyfile was not executed in the authoring environment.
