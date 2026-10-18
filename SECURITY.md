# SECURITY.md — threat model, controls, limitations

## Attackers and protected assets

| Asset | Attacker | Primary controls |
|---|---|---|
| Account credentials / sessions | Internet brute force, credential stuffing | scrypt (memory-hard), generic login errors, auth rate limit (20/min/IP), session revocation, audit log |
| API tokens | Token theft from disk/logs | Hashed at rest (SHA-256), one-time display, `0600` config file, redaction, instant revoke |
| Route ownership | Cross-user hijack, slot races, username squatting | Segment-aware routing, transactional allocation, reserved names, `a-` namespace reserved, unique lowercase usernames, offline routes stay owned |
| Quotas | Bypass attempts, double counting | Server-side metering only, fail-closed gate, no client control, persisted aggregates |
| Anonymous capacity | Abuse/flooding | 1800s TTL, per-IP caps, body-size caps, per-tunnel concurrency, rate limits |
| Server resources | Oversized/malformed input | Bounded bodies/frames/queues, runtime frame validation, connection limits, timeouts |
| Admin surface | Privilege escalation | Role checks on every `/api/v1/admin/*` (server-side only, never frontend guards), self-demotion/last-admin guards, audit of every privileged action |
| Internal network | SSRF via tunnel metadata | **Tunnels never dial user-chosen destinations** — only the CLI opens local connections; gateway opens no outbound sockets |

## Trust boundaries

1. **Public internet → gateway:** all input untrusted. Paths decoded once, matched on whole segments; system prefixes reserved; hop-by-hop headers stripped; header values capped.
2. **CLI → control plane:** authenticated (token) or anonymous namespace; every frame runtime-validated (`packages/protocol/src/validate.ts`); clients cannot register arbitrary usernames/route ids — the server assigns routes from the authenticated identity.
3. **Local app → tunnel:** user-controlled app responses pass through; `set-cookie`/redirects preserved (that's the product), but response headers cross hop-by-hop stripping and size caps.
4. **Store file:** contains only hashes for credentials/token secrets; no recoverable tokens. Treat the volume as sensitive.

## Implemented controls (mapped to tests)

- Username rules: length 3–32, `a-z0-9-_`, reserved list + `a-` prefix (`unit.test.ts`, `security.test.ts`).
- Route parsing: segment-aware, `%2f`/`%2e` cases tested; lookalike usernames never cross-serve (`security.test.ts`).
- Free limit 3 concurrent tunnels; freed by explicit stop; race-safe allocation (integration tests).
- Anonymous expiry: server timestamps only; resume cannot extend; sweeper terminates and marks `expired`; restart recovery (e2e + integration).
- Quotas: upload=request bytes to local, download=response bytes to visitor; dashboard/API show the same convention; exhausted ⇒ 429 `QUOTA_EXCEEDED_*`; persisted (integration).
- Cookies: HttpOnly, SameSite=Lax, Secure when base URL is https, 7-day expiry, per-session revoke.
- Tokens: `tmin_…` random 160-bit, hashed, optional expiry, last-used stamp, revoke test in security suite.
- Device login (`tmin login`): user code from a 29-symbol alphabet (no `0/O/1/I/L/U`), dashless
  at rest, device code random 256-bit stored only as a SHA-256 hash; 600 s TTL; poll interval
  enforced (`SLOW_DOWN`); single-use (one token per approved code); approve/deny requires a
  signed-in session and is audited; unknown/expired codes fail closed (`device.test.ts`).
- Web console pages are static clients of the REST API: the CSP allows the Tailwind CDN and
  assets only (`PAGE_CSP`), and no authorization decision is made client-side.
- Admin: env-bootstrap once; no public admin registration; suspend kills live tunnels and blocks login/public routes (security suite); rename guarded (no live tunnels); audit rows for actions.
- Protocol: JSON frames validated; chunk size caps; heartbeat timeouts close stale sockets; malformed hello/reply frames rejected (`oversized … malformed WS frames` test).
- Maintenance mode: public gateway fails closed (503) while `/health` stays up.
- Error hygiene: structured error bodies with codes + requestId; production 500s are generic (`INTERNAL_ERROR`), no stack traces.
- Claimed IPs: `X-Forwarded-For` honored only when `TRUST_PROXY=true` (documented for reverse-proxy deployments).

## Known limitations (honest list)

- **No per-route access policies yet** (basic-auth/bearer/IP allowlist/share tokens are Milestone H). A public URL currently means public access — do not expose sensitive apps expecting URL secrecy.
- **Custom domains not implemented.**
- **Single-instance only.** Do not run behind a load balancer with multiple app instances: live registry is process-local.
- Admin global quota `PATCH` is runtime-only (not persisted across restarts).
- Password reset requires email delivery integration (dev mode returns the token when `NODE_ENV!=production`); plan accordingly for production.
- Anonymous resume secrets are process-local (restart invalidates pending resumes; sessions still expire correctly).
- No 2FA, no email verification enforcement (optional email stored only).
- Reverse-proxy example (`deployment/Caddyfile`) is provided but was not executed in the authoring sandbox; the app layer itself is tested directly.

## Operational requirements

- Set `SESSION_SECRET` (≥32 chars) and a strong `ADMIN_PASSWORD` before first production start; the server refuses weak production secrets.
- Terminate TLS in front (Caddy example provided) and set `TRUST_PROXY=true` **only** behind that proxy.
- Back up `DATA_DIR` (contains all durable state). Rotate `ADMIN_PASSWORD` via admin reset + bootstrap policy documented in DECISIONS.md.
- `npm audit` at your discretion — the runtime dependency surface is one package (`ws`).
