/** Interactive documentation (served at /docs, no build step). */

const SECTIONS: Array<{ id: string; title: string; body: string }> = [
  { id: "start", title: "Getting started", body: `<p>Run your own server (see <a href="#deploy">deployment</a>), then:</p><pre>tmin config set server https://tunnel.example.com
tmin http 3000 --anonymous   # instant short-lived link (default 30 min)
tmin login                   # interactive sign-in (revocable token, stored 0600)
tmin http 3000               # permanent https://SERVER/&lt;you&gt;</pre>` },
  { id: "arch", title: "Architecture", body: `<p>One Node process serves the REST API, the WebSocket control plane (<code>/tunnel</code>), the public gateway and the dashboards. The CLI dials <b>out</b>; public traffic rides that socket. The server never dials into your network. Live reachability lives in memory; route <b>ownership</b> lives in the JSON store (migrated, atomically written). See ARCHITECTURE.md in the repo.</p>` },
  { id: "install", title: "Installation", body: `<pre>git clone &lt;repo&gt; && cd tmin
npm install            # only dependency: ws
npm run build && npm start</pre><p>Requires Node 20+. No database server needed for single-server mode.</p>` },
  { id: "cli", title: "CLI installation", body: `<p>From the repo root, one command installs the global <code>tmin</code> CLI (builds automatically when needed):</p><pre>npm install
npm i -g .
tmin --help

# no global install? run from the repo:
npm run cli -- --help</pre>` },
  { id: "anon", title: "Anonymous tunnels", body: `<p><code>tmin http 3000 --anonymous</code> returns <code>/a-xxxxxx</code>. The <b>server</b> sets expiry = start + <code>ANONYMOUS_TUNNEL_TTL_SECONDS</code> (default 1800s); reconnecting with the resume token rejoins the <b>same</b> session without extending it. Offline anonymous paths show the offline page (502); expired ones return 410. Per-IP concurrency and body-size caps apply (see .env.example).</p>` },
  { id: "accounts", title: "Registration and login", body: `<p>Register in the dashboard or <code>POST /api/v1/auth/register</code>. Usernames are lowercase-unique, 3–32 chars, <code>a-z 0-9 - _</code>, with system names reserved (<code>api admin dashboard docs login …</code>). Login sets an HttpOnly <code>tmin_sid</code> cookie; the CLI uses revocable bearer tokens (<code>tmin token create</code>).</p>` },
  { id: "named", title: "Named URLs", body: `<p>Your account owns <code>https://SERVER/&lt;username&gt;</code> forever. The route stays yours while offline (visitors see a friendly offline page); it never forwards to anyone else. Rename policy: only admins can rename, only with no live tunnels, fully audit-logged.</p>` },
  { id: "slots", title: "Multiple tunnels and route slots", body: `<pre>tmin http 3000          # → /you
tmin http 8080 --slot 2   # → /you/2
tmin http 5000 --slot 3   # → /you/3</pre><p>Allocation is transactional — concurrent connects can never double-book a slot. Max 3 live tunnels on the free plan (server-enforced, <code>TUNNEL_LIMIT_REACHED</code>).</p>` },
  { id: "forwarding", title: "HTTP and WebSocket forwarding", body: `<p>GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, query strings, headers, cookies, redirects and streaming bodies are proxied. Bodies stream in 48&nbsp;KB chunks with backpressure — nothing unbounded is buffered. WebSocket upgrades are bridged bidirectionally with frame-size and lifetime caps. Timeouts (30s default), cancellation and quota-exhausted-mid-stream all return explicit errors.</p>` },
  { id: "auth", title: "Authentication", body: `<p>Browsers: HttpOnly + SameSite=Lax cookies, 7-day expiry, per-session revocation. CLI/API: <code>tmin_…</code> bearer tokens, SHA-256 hashed at rest, optional expiry, last-used stamps, instant revocation. Passwords: scrypt (memory-hard, Node builtin). Reset tokens are single-use, 1-hour, and revoke all sessions. Auth endpoints are rate-limited with generic login failures.</p>` },
  { id: "tokens", title: "API tokens", body: `<pre>tmin token create --name laptop   # secret printed ONCE
tmin token list
tmin token revoke &lt;id&gt;</pre><p>Never put tokens in URLs or shell history — <code>tmin login</code> stores them with 0600 permissions.</p>` },
  { id: "api", title: "REST API reference", body: `<p>Versioned under <code>/api/v1</code>. Machine-readable spec at <a href="/openapi.json">/openapi.json</a> (generated from the route table; CI checks sync). Errors are <code>{error:{code,message},requestId}</code> with stable codes.</p>` },
  { id: "quotas", title: "Upload and download quotas", body: `<p>Convention: <b>upload</b> = public→local request bytes; <b>download</b> = local→public response bytes. Defaults: 1&nbsp;GB/day each (<code>FREE_*_LIMIT_BYTES</code>). Usage aggregates flush every 5s and survive restarts. Dashboards warn at 80%. Admins are uncapped. Exhaustion stops traffic with <code>QUOTA_EXCEEDED_*</code>, never silently.</p>` },
  { id: "access", title: "Access protection", body: `<p>Planned per-route policies (basic-auth / bearer / IP allowlist / share tokens) are <b>not yet enforced</b> — all routes are currently public. Do not rely on URL secrecy for sensitive apps. (Tracked in PLAN.md Milestone H.)</p>` },
  { id: "domains", title: "Custom domains", body: `<p><b>Planned, not implemented.</b> Path routing (<code>/username</code>) is the supported mode. Custom domains need DNS verification + per-domain TLS and are tracked in PLAN.md.</p>` },
  { id: "env", title: "Environment variables", body: `<p>See <code>.env.example</code> — every knob is documented there (domain, secrets, TTLs, quotas, protocol limits, rate limits, retention, maintenance).</p>` },
  { id: "deploy", title: "Self-hosted deployment", body: `<pre>git clone &lt;repo&gt; && cd tmin
npm ci --omit=dev && npm run build
SESSION_SECRET=… ADMIN_PASSWORD=… DATA_DIR=/var/lib/tmin npm start</pre><p>Single-server mode: one Node process, no database server. Run it under systemd (or any supervisor) — <code>Restart=always</code>, <code>EnvironmentFile=/etc/tmin.env</code>. Back up <code>data/tmin.json</code> (all durable state).</p>` },
  { id: "tls", title: "TLS and DNS", body: `<p>Point <code>A tunnel.example.com → server IP</code>. Run Caddy in front (example config: <code>deployment/Caddyfile</code>) — it obtains and renews Let's Encrypt certificates automatically and proxies HTTP+WebSocket to the app. Only trust <code>X-Forwarded-For</code> when <code>TRUST_PROXY=true</code> behind that proxy.</p>` },
  { id: "admin", title: "Administration", body: `<p>Bootstrap <code>ADMIN_USERNAME/PASSWORD/EMAIL</code> on first start only — restarts never overwrite it. Admins manage users, renames, quotas, tunnels, anonymous sessions, audit logs, maintenance mode and server health from <a href="/admin">/admin</a>. Every privileged action is audit-logged with actor, target and result.</p>` },
  { id: "security", title: "Security", body: `<p>Threat model, boundaries and controls: see SECURITY.md. Highlights: server-authoritative everything, segment-aware routing (no prefix capture), bounded buffers, fail-closed quota/auth, secret redaction, no stack traces in prod.</p>` },
  { id: "trouble", title: "Troubleshooting", body: `<pre>tmin doctor     # DNS, TLS, auth, version checks
tmin status     # connection, URL, usage
tmin usage --json</pre><p>Common: <code>TUNNEL_LIMIT_REACHED</code> → stop a tunnel; <code>QUOTA_EXCEEDED_*</code> → daily bandwidth cap reached; <code>ANON_EXPIRED</code> → anonymous links expire by design (default 30 min). If a named path shows the offline page, (re)start your CLI.</p>` },
  { id: "monitor", title: "Operational monitoring", body: `<p><code>GET /health</code> (public), <code>GET /ready</code> (db check), <code>GET /api/v1/admin/metrics</code> (live tunnels, latency, error rate, bytes). Structured JSON logs with request correlation IDs.</p>` },
  { id: "faq", title: "FAQ", body: `<p><b>Does my URL change on reconnect?</b> No — registered URLs are permanent.<br><b>Can someone steal my offline route?</b> No — ownership is per-account in the database.<br><b>Why scrypt instead of argon2?</b> Zero native deps keeps installs tiny and reproducible; still memory-hard.<br><b>Horizontal scaling?</b> Not with the embedded store — single-server mode is supported; multi-instance needs Postgres (planned).</p>` },
];

export function docsPage(): string {
  const nav = SECTIONS.map((s) => `<a href="#${s.id}">${s.title}</a>`).join("");
  const body = SECTIONS.map((s) => `<section class="card" id="${s.id}"><h2>${s.title}</h2>${s.body}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docs · tmin</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;background:#fafafa;color:#111}
nav{background:#111;color:#fff;padding:10px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}nav a{color:#fff;text-decoration:none;font-size:13px}
.wrap{display:grid;grid-template-columns:220px 1fr;max-width:1100px;margin:0 auto}aside{padding:20px;position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto}aside a{display:block;padding:4px 0;color:#333;font-size:14px}
main{padding:20px}.card{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:16px;margin:12px 0}
code{background:#f1f1f1;padding:2px 6px;border-radius:4px}pre{background:#111;color:#d6f5d6;padding:12px;border-radius:8px;overflow:auto;font-size:13px}
@media(max-width:760px){.wrap{grid-template-columns:1fr}aside{position:static;max-height:none}}</style></head>
<body><nav><a href="/" style="font-weight:700;font-size:16px">tmin</a><a href="/dashboard">Dashboard</a><a href="/admin">Admin</a><a href="/openapi.json">OpenAPI</a></nav>
<div class="wrap"><aside><b>Contents</b>${nav}</aside><main><h1>Documentation</h1>${body}</main></div></body></html>`;
}
