# tmin — Tunnel minimal

**Self-hosted tunneling platform.** Expose localhost to the internet through *your own* server — permanent `/username` URLs, 3 tunnel slots per account, 30-minute anonymous links, bandwidth quotas, dashboards, and a documented REST API. No ngrok, no vendor account.

One runtime dependency: [`ws`](https://www.npmjs.com/package/ws). The whole install is ~3 MB. No database server required (durable JSON store with migrations; Postgres path documented as planned).

## Quick start

**1. Clone and install the CLI** (Node.js ≥ 20; installs from this repo — the `tmin`
package on the npm registry is an unrelated project):

```bash
git clone https://github.com/Codeleafly/tmin.git
cd tmin
npm install
npm i -g .        # installs the global `tmin` command
tmin version
```

**2. Run your server:**

```bash
SESSION_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD='change-me-1!' npm start
# → http://localhost:8080
```

Open the web console in a browser: `/register` to create an account, `/login` to sign in,
`/dashboard` for tunnels/usage/API tokens, `/admin` for the admin panel (sign in as the
`ADMIN_USERNAME` — default `admin` — with the `ADMIN_PASSWORD` from the server env), and
`/docs` for the reference. The admin account is created once at first start; restarts never
overwrite its password.

**3. Expose something:**

```bash
# anonymous 30-minute link (no account)
tmin http 3000 --anonymous

# permanent URL
tmin login                 # approve a code in the browser (OAuth-style device flow)
tmin http 3000             # → https://<server>/<username>
tmin http 8080 --slot 2    # → /<username>/2
```

`tmin login` stores a revocable token (0600). Prefer no browser? `tmin login --token <secret>`
with a token created under Dashboard → API tokens, or `tmin login --password` for a direct
username/password prompt.

Prefer no global install? `npm run cli -- http 3000 --anonymous` works too.

> Termux note: Termux lacks `/usr/bin/env`. Install hooks detect this and replace the global bin symlink with a tiny `sh` wrapper that execs `node` directly — so `tmin` just works, in any shell. (Interactive Termux shells also work via `termux-exec`.)

## What's inside

| Piece | Where |
|---|---|
| Public gateway + REST API + WS control plane | `apps/server` |
| CLI (`tmin`) | `apps/cli` |
| Versioned protocol (typed frames + runtime validation) | `packages/protocol` |
| Shared rules: usernames, route parsing, quota math, errors, config | `packages/shared` |
| Web console: static pages (Tailwind CDN + JS), served at `/`, `/login`, `/register`, `/dashboard`, `/admin`, `/device`, `/docs` | `web/` |
| OpenAPI at `/openapi.json` | built-in |
| Caddy TLS reverse-proxy example | `deployment/` |
| Replit import/run config (Run button + Publish) | `.replit`, `replit.nix` |

## Commands

```bash
npm run build           # compile TypeScript (strict)
npm run typecheck       # tsc --noEmit
npm run lint            # structural hygiene (no console.log, secrets, giant files, HTML in server src)
npm test                # full suite: unit + integration + e2e + security + CLI + device flow (69 tests)
npm run smoke           # boots the real binary and checks public surfaces
npm run test:unit       # fast subset
npm run test:integration
npm run test:e2e
```

## Product invariants (server-enforced, tested)

- Anonymous tunnels expire **server-side after 1800s** — reconnect with the resume token rejoins the *same* session, never extending it.
- Free accounts: **max 3 concurrent tunnels** (`TUNNEL_LIMIT_REACHED`), transactional slot allocation (`/you`, `/you/2`, `/you/3`).
- Registered URLs are **permanent**; offline routes keep their owner and never forward to anyone else.
- Upload/download quotas (default 1 GB/day each, `FREE_*_LIMIT_BYTES`) are metered and persisted; exhausted quotas stop traffic with explicit errors.
- Admin is bootstrapped from env **once** — restarts never overwrite the password.
- API tokens are stored **hashed** (SHA-256), shown once, revocable instantly.
- Device-login codes (`tmin login`) expire after **10 minutes**, are single-use, are stored
  hashed, and only mint a token after the signed-in user approves them at `/device`.

## Docs

- `ARCHITECTURE.md` — components, flows, state ownership, deployment topology
- `SECURITY.md` — threat model, controls, known limitations
- `DECISIONS.md` — why ws-only, JSON store, scrypt, path routing
- `TESTING.md` — test strategy, what's covered, how to verify manually
- `PLAN.md` — milestones and current status
- `AGENTS.md` — instructions for future coding-agent sessions
- `CHANGELOG.md` — user-visible changes

## License

MIT — see `LICENSE`.
