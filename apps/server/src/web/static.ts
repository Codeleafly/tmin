/**
 * Static web UI — serves the `web/` directory (Tailwind CDN + plain JS, no build step).
 * HTML pages get template placeholders replaced ({{baseUrl}}, {{version}}, ...) on serve.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import type { AppConfig } from "../../../../packages/shared/src/index";
import { sendHtml, sendError } from "../http";
import { logger } from "../logger";

const PAGE_ROUTES: Record<string, string> = {
  "/": "index.html",
  "/login": "login.html",
  "/register": "register.html",
  "/dashboard": "dashboard.html",
  "/admin": "admin.html",
  "/docs": "docs.html",
  "/device": "device.html",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

let cachedDir: string | null = null;

/** Resolve the shipped web/ directory (works from dist/ and from a global install). */
export function webDir(): string | null {
  if (cachedDir && existsSync(cachedDir)) return cachedDir;
  const candidates = [
    process.env.TMIN_WEB_DIR,
    path.resolve(__dirname, "../../../../../web"),
    path.resolve(process.cwd(), "web"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(path.join(c, "index.html"))) {
      cachedDir = c;
      return c;
    }
  }
  return null;
}

function version(): string {
  try {
    const pkg = require("../../../../../package.json") as { version?: string };
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
}

export function pageFor(pathname: string): string | null {
  return PAGE_ROUTES[pathname] ?? null;
}

/** Replace server-side template placeholders in a page. */
export function renderTemplate(html: string, cfg: AppConfig): string {
  const base = cfg.publicBaseUrl.replace(/\/$/, "");
  return html
    .replaceAll("{{baseUrl}}", base)
    .replaceAll("{{anonTtlSeconds}}", String(cfg.anonymousTtlSeconds))
    .replaceAll("{{anonTtlMinutes}}", String(Math.max(1, Math.round(cfg.anonymousTtlSeconds / 60))))
    .replaceAll("{{version}}", version());
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Render web/offline.html for a route path (escaped — the path is user-controlled). */
export function renderOffline(html: string, cfg: AppConfig, routePath: string): string {
  return renderTemplate(html, cfg).replaceAll("{{routePath}}", escapeHtml(routePath));
}

/**
 * Serve the 502 "route offline" page from web/offline.html. Falls back to a JSON
 * ROUTE_OFFLINE error when the web/ directory is unavailable (never inline HTML).
 */
export function serveOffline(res: ServerResponse, cfg: AppConfig, routePath: string, requestId?: string): void {
  const dir = webDir();
  if (dir) {
    try {
      const html = renderOffline(readFileSync(path.join(dir, "offline.html"), "utf8"), cfg, routePath);
      if (requestId) res.setHeader("x-request-id", requestId);
      sendHtml(res, html, 502);
      return;
    } catch (e) {
      logger.warn("failed to serve offline page", { err: String(e) });
    }
  }
  sendError(res, "ROUTE_OFFLINE", "Route has no live tunnel connected.", undefined, requestId);
}

export function servePage(res: ServerResponse, page: string, cfg: AppConfig): boolean {
  const dir = webDir();
  if (!dir) {
    logger.warn("web/ directory not found — UI pages unavailable", {});
    return false;
  }
  const full = path.join(dir, page);
  try {
    const html = renderTemplate(readFileSync(full, "utf8"), cfg);
    sendHtml(res, html);
    return true;
  } catch (e) {
    logger.warn("failed to serve page", { page, err: String(e) });
    return false;
  }
}

/** Serve /assets/* from web/assets with traversal protection. Returns false when not found. */
export function serveAsset(res: ServerResponse, relPath: string, requestId?: string): boolean {
  const dir = webDir();
  if (!dir) return false;
  const assetsRoot = path.resolve(dir, "assets");
  const full = path.resolve(assetsRoot, relPath);
  if (full !== assetsRoot && !full.startsWith(assetsRoot + path.sep)) {
    sendError(res, "NOT_FOUND", "Not found.", undefined, requestId);
    return true;
  }
  try {
    if (!statSync(full).isFile()) return false;
    const ext = path.extname(full).toLowerCase();
    const body = readFileSync(full);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      ...(requestId ? { "x-request-id": requestId } : {}),
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
