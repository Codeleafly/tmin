# ARCHITECTURE.md — tmin (Tunnel minimal)

## Components

```
┌─────────────┐   HTTPS    ┌───────────────────────── tmin server (one Node process) ─────────────────────────┐
│   Browser   │──────────▶ │  Caddy/Ingress (TLS)  →  index.ts router                                      │
│  or API     │            │     ├─ /api/v1/*            REST API (auth, me, tokens, tunnels, routes, admin) │
│   client    │            │     ├─ / /login /register /dashboard /admin /docs /openapi.json  (HTML/JSON)   │
└─────────────┘            │     └─ /<username>[/2|/3]    public gateway → quota gate → live registry      │
                           │                                    │ (correlation-id multiplexing)          │
                           │  ws://.../tunnel  ◀── control plane┘                                        │
                           │  db/store.ts (JSON, atomic writes, migrations)   usage.ts (hot byte counters)│
                           │  sweeper.ts (anon expiry, stale tunnels, retention)                          │
                           └──────────────────────────────────────────────────────────────────────────────┘
                                     ▲ outbound WebSocket (CLI dials server; server never dials client)
                           ┌─────────┴──────────┐
                           │  tmin CLI       │  HTTP/WS forwarding
                           │  forward.ts         │──────────▶  local app (127.0.0.1:PORT)
                           └────────────────────┘
```

## Request flow (public HTTP)

1. TLS terminates at Caddy; plain HTTP reaches the server.
2. Router (`index.ts`) reserves system prefixes (`api/admin/dashboard/docs/login/...`) — they can never be tunnel paths.
3. `gateway/router.ts` parses the path **segment-aware** (`packages/shared/src/routes.ts`): `/<username>[/slot][/rest?query]`. `"/myapp2"` is a different username than `"/myapp"`; `%2f` decoding is single-pass.
4. Owner lookup: DB route row (`usernameLower + slot`) → owner account (status checked). Anonymous paths (`/a-…`) resolve against `anonSessions` with authoritative `expiresAt`.
5. Quota gate (fail-closed): daily upload/download totals vs. limits (admins uncapped).
6. Live registry (`tunnels/registry.ts`) returns the in-memory tunnel **only if a WS is connected**. No live tunnel ⇒ offline page (502) — never a different account's app.
7. Body read bounded → `dispatchToTunnel()` frames: `request_head` + `request_chunk*` (48 KB, base64). Per-tunnel concurrency cap (`MAX_CONCURRENT_PER_TUNNEL`, default 50) and request timeout apply.
8. CLI reassembles, re-frames deterministically (`content-length` recomputed), calls local app, streams back `response_head/chunk*/end`.
9. Server completes the public response, meters bytes, writes a request-log row (bounded).

WebSocket: `/tunnel` = CLI control plane. Public WS upgrades on tunnel paths are bridged: token frames through the same tunnel socket (`request_head{wsUpgrade}` → `ws_opened/ws_frame*/ws_closed`), with frame-size cap, lifetime cap, early-frame buffering on the CLI side, and cancellation.

## State ownership (single source of truth)

| State | Owner | Durability |
|---|---|---|
| Accounts, usernames, roles | `db.users` | durable |
| **Route ownership** (username+slot → user) | `db.routes` | durable |
| Live reachability (who is connected now) | in-memory registry | ephemeral by design; reconciled at boot (`recoverAfterRestart` marks old rows closed) |
| Anonymous sessions + expiry | `db.anonSessions` (server sets `expiresAt`; sweeper enforces) | durable |
| Byte usage | hot counters in `usage.ts`, flushed to `db.usage` (5s) | durable after flush |
| Sessions / tokens | `db.sessions`, `db.tokens` (hashes only) | durable |
| Audit, request logs | `db.audit`, `db.requestLogs` | durable, retention-pruned |
| Admin global quota edits | running config | **not persisted** (documented limitation) |

A DB tunnel row saying `connected` is never trusted — `status: "stale"` is displayed when the socket is gone.

## Storage & migrations

`db/store.ts`: schema v3, sequential migrations in `migrate()` (v1 normalize users, v2 per-user limits + token prefixes, v3 anon sessions + tunnel metadata). Writes are atomic (`tmp` + rename). Transactions serialize via an in-process promise chain (`store.tx`) — this is what makes concurrent slot allocation safe.

**Restart behavior:** live sockets die; on boot, `recoverAfterRestart()` marks `connected` tunnel rows `closed` and stale anon sessions `expired`. Registered users simply reconnect (`tmin http …`) and re-assert the same route rows. Anonymous resume keys are process-local, so a resume after restart fails cleanly (`ANON_EXPIRED` path) while the session row remains correctly expired.

## Deployment topology

- **Single-server mode (supported):** one app instance + persistent volume for `data/`. No Redis/DB server needed. Caddy terminates TLS and proxies HTTP+WS.
- **Multi-instance mode (planned, NOT implemented):** requires replacing the JSON store with Postgres and adding cross-instance delivery (pub/sub) so a request landing on gateway A can reach a tunnel held by instance B. Until that exists, do not run more than one gateway instance — the live registry is process-local and requests for tunnels on another instance would 404/502.

Scale limits (per process): public gateway + control plane share one event loop; tune `MAX_CONCURRENT_PER_TUNNEL`, `MAX_BODY_BYTES`, `RATE_PUBLIC_PER_MIN` for your workload. Byte metering uses in-memory hot counters specifically to avoid per-chunk persistence writes.

## Sub-path semantics

A tunnel at `/alice` receives `/alice/api/users` as `/api/users` at the local app (path prefix stripped). Full original URL is available via `x-request-id` correlation and request logs; absolute redirects returned by a local app are passed through unchanged (behave accordingly — use relative redirects in local apps).
