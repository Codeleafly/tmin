# DECISIONS.md — architectural decision records

## ADR-1: `ws` as the only runtime dependency (no Fastify/Prisma/Zod/Next.js)
**Context:** The brief suggested Fastify + Postgres + Prisma + Zod + Next.js; the owner's constraint: tiny install (~3 MB), light data budget, "ws only".
**Decision:** Node `http`/`crypto` builtins + `ws` 8.x. Validation is hand-written but centralized (`packages/shared/src/validate.ts`, `packages/protocol/src/validate.ts`); errors/types are shared TS code.
**Consequences:** Zero native builds, installs in seconds, runs on Termux. Trade-off: no ORM/migration tool — we wrote a 200-line store with migrations (still fully tested). If the project later needs multi-instance, the store interface is the seam to swap for Postgres.

## ADR-2: Durable JSON store with sequential migrations instead of Postgres
**Context:** Single-server mode is the stated goal; Postgres would add infra weight with no benefit at this stage.
**Decision:** One JSON document (`DATA_DIR/tmin.json`), atomic writes (`tmp`+rename), in-process serialized transactions, `SCHEMA_VERSION=3` with forward migrations.
**Consequences:** All invariants (unique username, slot allocation) enforced in the same process with `store.tx` — race-free for a single instance. Documented limitation: no multi-instance; Postgres path is a planned milestone (schema sketch in PLAN.md).

## ADR-3: scrypt instead of Argon2id
**Context:** Brief recommends Argon2id; Argon2 requires native compilation (`argon2` npm) — breaks the tiny-install constraint and adds build risk.
**Decision:** scrypt (N=16384, r=8, p=1, 64-byte output) via `node:crypto`, stored as `scrypt$v1$salt$hash`.
**Consequences:** Memory-hard, constant-time verify, zero deps. Argon2 migration is possible later: the versioned hash prefix allows dual-verify.

## ADR-4: Path-based permanent URLs (`/<username>[/slot]`), not subdomains
**Context:** Subdomain routing needs wildcard DNS + wildcard TLS; path routing works with a plain server IP and one certificate.
**Decision:** Segment-aware path router. Usernames are lowercase-unique and system prefixes are reserved; `a-` prefix reserved for anonymous tokens.
**Consequences:** One cert covers everything; documented sub-path semantics (prefix stripped before forwarding). Custom domains are a planned addition, not retrofitted into this scheme.

## ADR-5: Anonymous sessions keyed by DB row; resume token never extends expiry
**Context:** Requirement: 1800s anonymous TTL, reconnect must not reset it, sweeper as fallback only.
**Decision:** `anonSessions` row holds `expiresAt` set at hello. Resume token (process-local map hash→session) rejoins the same row; gateway checks `expiresAt` at admission; sweeper enforces periodically; restart marks stale sessions expired.
**Consequences:** TTL is authoritative even if the CLI is modified. Resume-through-restart is sacrificed for simplicity (documented; fails cleanly).

## ADR-6: Byte accounting convention
**Decision:** upload = request-body bytes public→local; download = response-body bytes local→public. Headers/TLS/control frames excluded. Implemented once in `usage.ts`, surfaced identically in CLI, dashboard, API.
**Why:** Ambiguity is the main quota-support failure mode; one sentence defines it everywhere.

## ADR-7: WebSocket multiplexing with explicit chunking
**Context:** One WS per CLI process; many concurrent public requests.
**Decision:** `requestId` correlation; bodies stream in 48 KB base64 chunks; per-tunnel in-flight cap; 30 s default timeout; cancellation frames. No unbounded queues — public WS frames buffer at most 256 frames / 1 MiB while the local socket connects.
**Consequences:** Deterministic memory bounds; base64 costs ~33% overhead on the wire (acceptable for tunnels over TLS; documented).

## ADR-8: Server-rendered dashboards instead of Next.js
**Context:** Brief suggests Next.js; constraint says light and no frameworks.
**Decision:** HTML/CSS/vanilla-JS pages served by the server (`web/pages.ts`, `web/docs.ts`), calling the documented REST API.
**Consequences:** No build step, no node_modules growth; UI is real (backed by tested APIs) and works without JS for docs/landing. Trade-off: less component tooling — acceptable for this scope.

## ADR-9: Admin bootstrap semantics
**Decision:** `ADMIN_USERNAME/PASSWORD/EMAIL` creates the admin **only when no admin exists**. Restarts never touch the password. Rotation = admin reset via `/api/v1/admin/users/:id/reset-password` (or, for lockout, edit the user record offline while server is stopped — documented procedure).
**Why:** The brief explicitly forbids overwriting credentials on restart.

## ADR-10: Port 0 + module-cache isolation for tests
**Decision:** Tests boot the real server (`start()`) on an ephemeral port with a temp `DATA_DIR` and cleared module cache, so every suite gets fresh in-memory registries and hot counters while exercising production code paths.
**Consequences:** Suites can run in parallel files safely; CLI tests spawn the real CLI binary against the real server (no mocks).
