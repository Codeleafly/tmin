/** OpenAPI 3.0 spec generated from the implemented route table. Keep in sync (see test/openapi.test.ts). */

export interface RouteDoc {
  method: string;
  path: string;
  summary: string;
  auth: "none" | "session-or-token" | "admin";
  tags: string[];
}

export const ROUTE_TABLE: RouteDoc[] = [
  { method: "POST", path: "/api/v1/auth/register", summary: "Register a new account (reserves username)", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/login", summary: "Login (sets HttpOnly session cookie)", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/logout", summary: "Logout (revokes session)", auth: "session-or-token", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/forgot-password", summary: "Start password reset (generic response)", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/reset-password", summary: "Complete password reset", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/change-password", summary: "Change password (revokes other sessions)", auth: "session-or-token", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/device/authorize", summary: "Start OAuth-style device login (CLI)", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/device/token", summary: "Poll device login; returns bearer token once approved", auth: "none", tags: ["auth"] },
  { method: "POST", path: "/api/v1/auth/device/verify", summary: "Check / approve / deny a device code (browser)", auth: "session-or-token", tags: ["auth"] },
  { method: "GET", path: "/api/v1/me", summary: "Current account", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/me/usage", summary: "Upload/download usage for current period", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/me/limits", summary: "Configured limits", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/me/tunnels", summary: "My tunnels (live + history)", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/me/routes", summary: "My route assignments + free slots", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/sessions", summary: "Active browser sessions", auth: "session-or-token", tags: ["me"] },
  { method: "DELETE", path: "/api/v1/sessions/{id}", summary: "Revoke a session", auth: "session-or-token", tags: ["me"] },
  { method: "GET", path: "/api/v1/tokens", summary: "List API tokens (never secrets)", auth: "session-or-token", tags: ["tokens"] },
  { method: "POST", path: "/api/v1/tokens", summary: "Create token (secret shown once)", auth: "session-or-token", tags: ["tokens"] },
  { method: "DELETE", path: "/api/v1/tokens/{id}", summary: "Revoke a token", auth: "session-or-token", tags: ["tokens"] },
  { method: "POST", path: "/api/v1/tunnels", summary: "Reserve a route slot for a tunnel", auth: "session-or-token", tags: ["tunnels"] },
  { method: "GET", path: "/api/v1/tunnels", summary: "List my tunnels", auth: "session-or-token", tags: ["tunnels"] },
  { method: "GET", path: "/api/v1/tunnels/{id}", summary: "Tunnel detail", auth: "session-or-token", tags: ["tunnels"] },
  { method: "DELETE", path: "/api/v1/tunnels/{id}", summary: "Terminate a tunnel", auth: "session-or-token", tags: ["tunnels"] },
  { method: "GET", path: "/api/v1/tunnels/{id}/metrics", summary: "Tunnel metrics + recent requests", auth: "session-or-token", tags: ["tunnels"] },
  { method: "GET", path: "/api/v1/routes", summary: "List my routes", auth: "session-or-token", tags: ["routes"] },
  { method: "POST", path: "/api/v1/routes", summary: "Allocate a route slot", auth: "session-or-token", tags: ["routes"] },
  { method: "GET", path: "/api/v1/routes/{id}", summary: "Route detail", auth: "session-or-token", tags: ["routes"] },
  { method: "DELETE", path: "/api/v1/routes/{id}", summary: "Release a route (refused while live)", auth: "session-or-token", tags: ["routes"] },
  { method: "GET", path: "/api/v1/admin/users", summary: "User directory (paginated, filterable)", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/users/{id}", summary: "User detail + usage", auth: "admin", tags: ["admin"] },
  { method: "PATCH", path: "/api/v1/admin/users/{id}/status", summary: "Suspend / reactivate", auth: "admin", tags: ["admin"] },
  { method: "PATCH", path: "/api/v1/admin/users/{id}/limits", summary: "Per-user quota overrides", auth: "admin", tags: ["admin"] },
  { method: "PATCH", path: "/api/v1/admin/users/{id}/role", summary: "Change role", auth: "admin", tags: ["admin"] },
  { method: "PATCH", path: "/api/v1/admin/users/{id}/username", summary: "Rename user (routes follow)", auth: "admin", tags: ["admin"] },
  { method: "POST", path: "/api/v1/admin/users/{id}/revoke-sessions", summary: "Revoke sessions + tokens", auth: "admin", tags: ["admin"] },
  { method: "POST", path: "/api/v1/admin/users/{id}/reset-password", summary: "Admin password reset", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/tunnels", summary: "All live tunnels", auth: "admin", tags: ["admin"] },
  { method: "DELETE", path: "/api/v1/admin/tunnels/{id}", summary: "Terminate any tunnel", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/anon", summary: "Anonymous sessions + expiry", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/metrics", summary: "Server metrics", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/audit-logs", summary: "Audit log search", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/config/quotas", summary: "Global quota policy", auth: "admin", tags: ["admin"] },
  { method: "PATCH", path: "/api/v1/admin/config/quotas", summary: "Update global quota policy", auth: "admin", tags: ["admin"] },
  { method: "POST", path: "/api/v1/admin/maintenance", summary: "Toggle maintenance mode", auth: "admin", tags: ["admin"] },
  { method: "GET", path: "/api/v1/admin/health", summary: "Health + dependency status", auth: "admin", tags: ["admin"] },
];

export function buildOpenApi(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTE_TABLE) {
    const p = r.path.replace(/\{id\}/g, "{id}");
    paths[p] = paths[p] || {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary,
      tags: r.tags,
      security: r.auth === "none" ? [] : [{ bearerAuth: [], cookieAuth: [] }],
      responses: {
        "200": { description: "OK" },
        "201": { description: "Created" },
        "400": { description: "Bad request (see error.code)" },
        "401": { description: "Not authenticated" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
        "429": { description: "Rate limited / quota exhausted" },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "tmin tunnel API",
      version: "v1",
      description:
        "Versioned REST API for the tmin self-hosted tunneling platform. Auth: HttpOnly session cookie (browser) or `Authorization: Bearer <token>` (CLI/API). Error bodies: `{ error: { code, message }, requestId }`.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "tmin_sid" },
      },
      schemas: {
        ApiError: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
            requestId: { type: "string" },
          },
        },
      },
    },
    paths,
  };
}
