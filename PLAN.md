# PLAN.md — milestones and status

Project: **tmin** (Tunnel minimal) — self-hosted tunneling platform.
Stack: Node.js + TypeScript (strict), single runtime dep `ws`, Node built-in test runner, JSON durable store with migrations.

Legend: [x] done & verified · [~] partial · [ ] planned

## Milestone A — Foundation ✅
- [x] Monorepo (npm workspaces: apps/server, apps/cli, packages/protocol, packages/shared)
- [x] Strict TS, single build to `dist/` (no per-package builds)
- [x] Env-validated config (`packages/shared/src/config.ts`), fail-fast in production
- [x] Durable store + versioned migrations (`SCHEMA_VERSION = 3`)
- [x] Structured logger, typed error codes, lint script, docs skeleton
- Exit: `npm run build && npm test` green.

## Milestone B — Auth & data model ✅
- [x] Registration, login, logout, scrypt password hashing (memory-hard, Node builtin)
- [x] HttpOnly cookie sessions (7d), revocation, session listing
- [x] API tokens: hashed at rest, one-time secret display, expiry, last-used, revoke
- [x] Password change (revokes other sessions), reset flow (single-use, 1h; dev returns token)
- [x] Admin bootstrap from env — first start only, never overwritten on restart
- [x] Audit log with actor/target/result; auth rate limiting; generic login errors
- Exit: ownership & permissions enforced by the backend (integration + security tests).

## Milestone C — Real tunnel connection ✅
- [x] Versioned protocol (hello/register/heartbeat/reply frames), runtime validation
- [x] WebSocket control plane at `/tunnel`; outbound-only (server never dials in)
- [x] Request multiplexing via requestId, 48 KB chunks, per-request timeout/cancel
- [x] Public gateway: segment-aware router → quota gate → live registry → tunnel
- [x] CLI: `http`, `login`, `logout`, `status`, `tunnels`, `stop`, `token *`, `config *`,
      `doctor`, `account`, `usage`, `route list|release`, `version`, `update`, `--json`
- Exit: real external HTTP client reaches a real local target through the gateway (e2e test + CLI test).

## Milestone D — Stable routes & limits ✅
- [x] Permanent username routes; slots `/u`, `/u/2`, `/u/3`; transactional allocation
- [x] Free limit 3 concurrent tunnels, server-enforced with `TUNNEL_LIMIT_REACHED`
- [x] Anonymous: 1800s server-owned expiry, resume without extension, sweeper fallback,
      per-IP caps, restart recovery, status transitions (active→expired)
- [x] Byte metering (upload=request body to local; download=response body to visitor),
      hot counters flushed every 5s, persisted; quota gate fail-closed
- Exit: invariants covered by integration + e2e tests.

## Milestone E — Protocol reliability ✅
- [x] Heartbeats both directions; dead-connection detection; sweeper stale cleanup
- [x] CLI reconnect with exponential backoff + jitter; same-route re-registration
- [x] WebSocket bridging (public ⇄ tunnel ⇄ local) with frame/lifetime caps + early-frame buffering
- [x] Timeouts (request 30s default), upstream-unavailable/offline pages, 504s
- [x] Graceful shutdown: drain window, tunnel shutdown frames, `SIGTERM`/`SIGINT`
- Exit: concurrent-request and failure behavior verified (e2e + cli.test).

## Milestone F — Public interfaces ✅
- [x] REST API v1 under `/api/v1` (auth, me, tokens, tunnels, routes, sessions, admin)
- [x] OpenAPI 3.0 generated from `ROUTE_TABLE`; served at `/openapi.json`; sync test
- [x] Landing, login, register, **dashboard** (overview/tunnels/usage/routes/tokens/sessions/security)
- [x] **Admin panel** (`/admin`): users, status, quotas, tunnels, anon sessions, audit, maintenance, health
- [x] Interactive docs site (`/docs`) covering every documented requirement topic
- Exit: full product usable without touching DB rows (verified via API/UI code paths + smoke).

## Milestone G — Hardening & operations ✅ (single-server scope)
- [x] Security tests: cross-user access, admin boundaries, token revocation, reserved names,
      encoded-path abuse, malformed/oversized frames, maintenance fail-closed
- [x] Rate limits (auth/api/public), bounded bodies/frames/queues, redaction
- [x] Metrics endpoint, health/ready, structured logs with request IDs
- [x] Caddy TLS reverse-proxy example (`deployment/Caddyfile`); `.env.example`
- [x] CI workflow (install → build → typecheck → lint → test)
- Exit: `npm run smoke` boots the real binary and passes all surface checks.

## Milestone H — Advanced (planned)
- [ ] Per-route access policies (basic auth / bearer / IP allowlist / share tokens)
- [ ] Custom domains with DNS verification + TLS automation
- [ ] Request inspector (opt-in, redacted, retention-limited)
- [ ] Webhook notifications, per-tunnel headers, idle timeouts toggle
- [ ] Multi-instance mode (Postgres + Redis pub/sub to reach live tunnels)
- [ ] TCP tunnels (separate protocol; explicit server-assigned ports)
- [ ] Email delivery for verification/reset (currently dev-only reset token)

## Current status

All automated suites green: **50 tests / 20 suites**, `lint OK`, `smoke ALL CHECKS PASSED`.
Unverified in this environment: real Let's Encrypt issuance, multi-instance mode (not implemented), Playwright browser tests (not present — dashboards are server-rendered and exercised via API tests + smoke).

## Next priorities (ordered)

1. Persist admin quota edits (currently runtime-only) into `db.settings`.
2. Per-route access policies (highest user value, security-sensitive).
3. `/api/v1/admin/config/quotas` persistence + tests.
4. Multi-instance design spike (Postgres + pub/sub) before any scaling claims.
5. Request inspector with strict redaction + retention.
