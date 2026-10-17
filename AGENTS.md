# AGENTS.md — instructions for coding-agent sessions

Persistent guidance for working on **tmin** (Tunnel minimal). Read this before changing code.

## Golden rules

1. **Server is authoritative.** The CLI/browser may never weaken a server-side rule (quota, expiry, slot, ownership, limit). Never add a client-side switch that bypasses a server check.
2. **Keep the dependency budget tiny.** Runtime deps: `ws` only. Do not add frameworks (no Fastify/Prisma/zod/Next.js) — evaluate alternatives with Node builtins first. Install size is a product feature (target ~3 MB).
3. **No giant files.** `scripts/lint.js` fails any source file > 700 lines, `console.log` in `apps/server/src` (use `logger`), `eval`, or hardcoded secret literals.
4. **Never break route semantics.** Routes are segment-aware (`packages/shared/src/routes.ts`). `"/myapp2"` must never match `"/myapp"`. Usernames starting with `a-` are reserved (anonymous namespace). If you touch routing, add/extend tests in `apps/server/test/unit.test.ts` + `security.test.ts`.
5. **Protocol frames are runtime-validated** even though both sides are TypeScript (`packages/protocol/src/validate.ts`). Every new frame needs validation + tests.
6. **Anonymous expiry is server-owned.** Reconnects must reuse `expiresAt`; never extend. Sweeper is the fallback, not the primary mechanism; the DB row is the source of truth.
7. **Quotas are fail-closed.** On uncertainty (e.g. usage row missing), reject traffic rather than allow.
8. **Don't invent verification.** Run `npm run build && npm run lint && npm test && npm run smoke` and report actual output. Never claim e2e/CI or external services work without running them.

## Layout

```
apps/server/src/
  index.ts          boot: HTTP server, WS upgrade routing, graceful shutdown
  gateway/router.ts public traffic: parse route → authz/quota → dispatch to live tunnel
  tunnels/handler.ts WS control plane (/tunnel): hello, register, reply frames, dispatch
  tunnels/registry.ts in-memory live reachability (NEVER route ownership)
  tunnels/routes.ts transactional slot allocation (DB)
  auth/             users, sessions, tokens, audit, secrets, auth context
  api/              auth.ts, resources.ts (user), admin.ts, openapi.ts (ROUTE_TABLE)
  usage.ts          byte metering (hot counters + flush)
  sweeper.ts        anon expiry, stale tunnels, retention, restart recovery
  db/store.ts       durable JSON store + migrations (SCHEMA_VERSION)
  web/              server-rendered pages (landing, auth, dashboard, admin, docs)
apps/cli/src/       index.ts (commands), forward.ts (tunnel+reconnect), api.ts, config.ts
bin/tmin.js         global CLI entry — installed with `npm i -g .` from the repo root
scripts/            lint.js, smoke.js, prepare.js (build-on-install), termux-link.js (Termux sh wrapper)
packages/protocol/  messages.ts (frames), validate.ts
packages/shared/    usernames, routes, quota, errors, config, passwords, time, ids
```

## Build & test

```bash
npm run build              # tsc -p tsconfig.json → dist/
npm run typecheck
npm run lint
npm test                   # all suites (Node built-in test runner)
npm run test:e2e           # real WS tunnel + real HTTP target
npm run smoke              # spawns dist binary, checks public surfaces
npm i -g .                 # global `tmin` command (prepare: build if stale + Termux shim)
```

Tests live in `apps/server/test/` (helpers.ts boots a real server on an ephemeral port with an isolated data dir; module cache is cleared per boot). CLI tests spawn the real CLI against the real server (`cli.test.ts`).

## Conventions

- Errors: typed codes in `packages/shared/src/errors.ts`, thrown as `Error & { code }`, mapped to HTTP via `statusFor`.
- Logging: structured `logger.child({...})`; never log tokens/passwords/cookies (use prefixes/redaction).
- DB changes: bump `SCHEMA_VERSION` in `db/store.ts` and add a sequential migration in `migrate()`; never mutate rows in place without migration for old files.
- API changes: add to `ROUTE_TABLE` in `api/openapi.ts`; `openapi.test.ts` asserts every documented route responds (no drift). Add request-body validation; keep pagination `?page&limit`.
- Commit hooks/CI must pass: install → build → typecheck → lint → test. Keep the CI file in `.github/workflows/ci.yml` in sync.

## Known intentional limitations (do not "fix" silently)

- Single-server mode only (in-memory live registry). Multi-instance needs a shared store/pubsub — documented, not implemented. Do not claim horizontal scaling.
- Custom domains, per-route access policies, request-body inspector: planned (PLAN.md Milestone H), not implemented.
- Anonymous resume secret map (`anonResumeSecrets`) is process-local; a server restart invalidates pending resumes (sessions stay expired correctly, resumes just fail cleanly).
- Admin global quota edits (`PATCH /api/v1/admin/config/quotas`) mutate the running config only; they are not persisted across restarts. Document, don't silently pretend otherwise.
