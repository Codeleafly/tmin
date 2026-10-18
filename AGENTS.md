# AGENTS.md — working instructions for coding agents

tmin (Tunnel minimal): self-hosted tunneling platform — server + global `tmin` CLI in one
package. Runtime dependency: `ws` only. Durable JSON store (no DB server), Node builtin test
runner, no build framework. Human overview: `README.md`. Design: `ARCHITECTURE.md`.

Every line here should prevent a mistake an agent would otherwise make. Keep it that way.

## Golden rules (violating any of these is a bug)

1. **Server is authoritative.** Never add a client-side switch that weakens a server check
   (quota, expiry, slot, ownership, limit).
2. **Dependency budget: `ws` only.** Node builtins before any package. Install size is a
   product feature (currently ~3 MB); this project is built for metered/data-limited machines.
3. **No giant files.** `scripts/lint.js` fails any source file > 700 lines, `console.log` in
   `apps/server/src` (use `logger`), `eval`, hardcoded secret literals, or HTML documents in
   `apps/server/src` (pages live in `web/`).
4. **Route semantics are segment-aware** (`packages/shared/src/routes.ts`). `"/myapp2"` must
   never match `"/myapp"`. Usernames starting with `a-` are reserved (anonymous namespace).
5. **Protocol frames are runtime-validated** even though both sides are TypeScript
   (`packages/protocol/src/validate.ts`). Every new frame needs validation + tests.
6. **Anonymous expiry is server-owned.** Reconnects reuse the stored `expiresAt`; never
   extend. The sweeper is a fallback — the DB row is the source of truth.
7. **Quotas are fail-closed.** On uncertainty (e.g. usage row missing), reject traffic.
8. **Never claim unverified behavior.** Run the commands below and report actual output.
   Never claim multi-instance, custom domains, Docker, or email delivery works — not implemented.

## Commands

```bash
npm install                # one dep + types
npm run build              # tsc -p tsconfig.json → dist/   (tests run from dist/)
npm run typecheck
npm run lint               # structural rules above
npm test                   # 69 tests: unit, integration, e2e (real sockets), security, CLI, device flow, openapi
npm run test:e2e           # real WS tunnel + real HTTP target
npm run smoke              # spawns the real binary, checks public surfaces
npm i -g .                 # global `tmin` command (prepare: build-if-stale + Termux shim)
```

**Definition of done:** `build` + `lint` + `test` + `smoke` all green, docs updated when
behavior changes, tests added/extended for behavior changes (even if not asked).

## Non-obvious conventions

- Errors: typed codes in `packages/shared/src/errors.ts`, thrown as `Error & { code }`,
  mapped to HTTP via `statusFor`.
- Logging: `logger.child({...})`; never log tokens/passwords/cookies (prefixes/redaction only).
- DB changes: bump `SCHEMA_VERSION` in `db/store.ts` **and** add a sequential migration in
  `migrate()`; old files must keep loading.
- API changes: register in `ROUTE_TABLE` (`api/openapi.ts`) — `openapi.test.ts` fails on
  drift and asserts every documented route actually responds. Validate request bodies; keep
  pagination `?page&limit`.
- Termux special-case: Termux has no `/usr/bin/env`; `scripts/termux-link.js` rewrites the
  global bin symlink into an `sh` wrapper (runs from `prepare`/`postinstall`). Do not "simplify"
  this away — it is the verified mechanism that makes `npm i -g .` reliable here.
- Tests: `apps/server/test/helpers.ts` boots a real server on an ephemeral port with an
  isolated `DATA_DIR` and cleared module cache; exports `boot()`, `http()`, `post()`,
  `mkUser()`, `mkToken()`, `TunnelClient`, `startTarget()`, `internals()`, `sleep()`,
  `flush()`. No mocks for networking; CLI tests spawn the real CLI.
- Expiry tests use short TTLs (`ANONYMOUS_TUNNEL_TTL_SECONDS=2`) — never wait 30 minutes.
- Node http gotcha: DELETE bodies need explicit `content-length` (already handled; don't
  regress the framing).
- Admin global quota edits (`PATCH /api/v1/admin/config/quotas`) mutate the running config
  only — **not persisted**. Documented limitation, do not silently change semantics.

## Known intentional limitations (do not "fix" silently or claim as done)

- Single-instance mode only (in-memory live registry). Multi-instance needs a shared
  store/pubsub — planned, not implemented. Never claim horizontal scaling.
- Custom domains, per-route access policies, request inspector, TCP tunnels: planned
  (PLAN.md Milestone H), not implemented. All routes are currently public.
- Anonymous resume secrets are process-local; a restart invalidates pending resumes
  (sessions still expire correctly).
- Password-reset email delivery is not integrated (dev mode returns the token).
- Docker was intentionally removed; `deployment/Caddyfile` is a plain reverse-proxy example.
- Caddyfile, Replit import config (`.replit`, `replit.nix`), and GitHub CI are the ops artifacts; CI is verified green on Node 20. Replit configs are provided as-is, not executed on Replit in the authoring environment.

## Orientation (read the listed doc before working in that area)

| Topic | Document |
|---|---|
| Setup, CLI usage, product invariants | `README.md` |
| Components, request flow, state ownership, deployment | `ARCHITECTURE.md` |
| Threat model, controls, limitations | `SECURITY.md` |
| Why ws-only / JSON store / scrypt / path routing | `DECISIONS.md` |
| Test strategy, manual verification, CI | `TESTING.md` |
| Milestones, status, next priorities | `PLAN.md` |
| User-visible changes | `CHANGELOG.md` |
| Every config knob | `.env.example` |

Only non-obvious paths (the rest is discoverable):

```
apps/server/src/index.ts          boot + WS upgrade routing + graceful shutdown
apps/server/src/gateway/router.ts public traffic: route → authz/quota → live tunnel
apps/server/src/tunnels/          handler.ts (WS control plane), registry.ts (live reachability),
                                  routes.ts (transactional slot allocation)
apps/server/src/db/store.ts       JSON store + migrations (SCHEMA_VERSION), store.tx serializes
apps/cli/src/                     index.ts (commands), forward.ts (tunnel + reconnect),
                                  login.ts (device flow / --token / --password)
bin/tmin.js                       global CLI entry — `npm i -g .` from repo root
web/                              static web console (Tailwind CDN + plain JS, no build step);
                                  served by apps/server/src/web/static.ts (+ {{placeholders}})
apps/server/src/api/device.ts     device login: authorize / token (poll) / verify (approve)
scripts/                          lint.js, smoke.js, prepare.js, termux-link.js
```

Web UI rules: pages live in `web/` only (never generate HTML inside `apps/server`), they are
pure REST clients, all authorization stays server-side. `web/` must stay in `package.json`
`files`. Device codes are hashed, single-use; never log user codes or device codes.
