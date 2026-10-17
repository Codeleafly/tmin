import type { IncomingMessage, ServerResponse } from "node:http";
import { newRequestId, statusFor, type ErrorCode } from "../../../packages/shared/src/index";

export function sendJson(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-request-id": requestId ?? newRequestId(),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  details?: unknown,
  requestId?: string,
): void {
  const rid = requestId ?? newRequestId();
  sendJson(res, statusFor(code), { error: { code, message, details }, requestId: rid }, rid);
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buf.length,
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  res.end(buf);
}

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > maxBytes) {
        failed = true;
        reject(Object.assign(new Error("Request body too large."), { code: "PAYLOAD_TOO_LARGE" }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Malformed JSON body."), { code: "BAD_REQUEST" }));
      }
    });
    req.on("error", reject);
  });
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  }
  return (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}
