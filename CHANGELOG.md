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
- 45 automated tests (unit, integration, e2e with real sockets, security, CLI subprocess, OpenAPI sync).

### Known at release
- Single-server mode only; custom domains, per-route access policies, request inspector, email delivery, TCP tunnels: planned (see PLAN.md Milestone H).
- Deployment examples (Caddy config, CI) are provided as-is; the Caddyfile was not executed in the authoring environment.
