import { isRecord, str, int, port } from "../../shared/src/index";
import type { ClientFrame, ServerFrame } from "./messages";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function headersOk(h: unknown): h is Record<string, string> {
  if (!isRecord(h)) return false;
  const keys = Object.keys(h);
  if (keys.length > 100) return false;
  for (const k of keys) {
    if (k.length > 256) return false;
    const v = (h as Record<string, unknown>)[k];
    if (typeof v !== "string" || v.length > 8192) return false;
  }
  return true;
}

function b64Ok(s: unknown, maxChars: number): s is string {
  return typeof s === "string" && s.length <= maxChars && /^[A-Za-z0-9+/=]*$/.test(s);
}

/** Validate inbound client frames; returns error string or null. */
export function validateClientFrame(f: unknown): string | null {
  if (!isRecord(f) || !str(f.type)) return "frame must have string type";
  const t = f.type as string;
  switch (t) {
    case "hello": {
      if (!int(f.protocolVersion, 1, 99)) return "hello.protocolVersion invalid";
      if (!isRecord(f.auth)) return "hello.auth invalid";
      if (f.auth.mode === "anonymous") break;
      if (f.auth.mode === "token") {
        if (!str(f.auth.token, 512)) return "hello.auth.token invalid";
        break;
      }
      return "hello.auth.mode invalid";
    }
    case "register":
      if (!int(f.slot, 1, 3)) return "register.slot must be 1..3";
      if (!port(f.localPort)) return "register.localPort invalid";
      if (f.target !== undefined && !str(f.target, 256)) return "register.target invalid";
      return null;
    case "heartbeat":
      return typeof f.at === "number" ? null : "heartbeat.at invalid";
    case "response_head":
      if (!str(f.requestId, 64)) return "response_head.requestId invalid";
      if (!int(f.status, 100, 599)) return "response_head.status invalid";
      if (!headersOk(f.headers)) return "response_head.headers invalid";
      return null;
    case "response_chunk":
      if (!str(f.requestId, 64)) return "response_chunk.requestId invalid";
      if (!b64Ok(f.data, 100 * 1024)) return "response_chunk.data invalid/too large";
      return null;
    case "response_end":
      return str(f.requestId, 64) ? null : "response_end.requestId invalid";
    case "response_error":
      if (!str(f.requestId, 64)) return "response_error.requestId invalid";
      if (!str(f.code, 64)) return "response_error.code invalid";
      return null;
    case "ws_opened":
      return str(f.requestId, 64) ? null : "ws_opened.requestId invalid";
    case "ws_frame":
      if (!str(f.requestId, 64)) return "ws_frame.requestId invalid";
      if (!b64Ok(f.data, 2 * 1024 * 1024)) return "ws_frame.data invalid/too large";
      return null;
    case "ws_closed":
      if (!str(f.requestId, 64)) return "ws_closed.requestId invalid";
      if (!int(f.code, 1000, 4999)) return "ws_closed.code invalid";
      return null;
    case "bye":
      return null;
    default:
      return `unknown client frame: ${t}`;
  }
  return null;
}

export function validateServerFrame(f: unknown): string | null {
  if (!isRecord(f) || !str(f.type)) return "frame must have string type";
  const t = f.type as string;
  switch (t) {
    case "welcome":
    case "registered":
      if (!str((f as Record<string, unknown>).tunnelId, 64)) return `${t}.tunnelId invalid`;
      if (!str((f as Record<string, unknown>).routePath, 128)) return `${t}.routePath invalid`;
      return null;
    case "request_head": {
      const r = f as unknown as { method: unknown; path: unknown; headers: unknown; requestId: unknown };
      if (!str(r.requestId, 64)) return "request_head.requestId invalid";
      if (!str(r.method, 16) || !METHODS.has((r.method as string).toUpperCase())) return "request_head.method invalid";
      if (!str(r.path, 4096)) return "request_head.path invalid";
      if (!headersOk(r.headers)) return "request_head.headers invalid";
      return null;
    }
    case "request_chunk":
      if (!str((f as Record<string, unknown>).requestId, 64)) return "request_chunk.requestId invalid";
      if (!b64Ok((f as Record<string, unknown>).data, 100 * 1024)) return "request_chunk.data invalid";
      return null;
    case "request_cancel":
    case "ws_close":
      return str((f as Record<string, unknown>).requestId, 64) ? null : `${t}.requestId invalid`;
    case "ws_frame":
      if (!str((f as Record<string, unknown>).requestId, 64)) return "ws_frame.requestId invalid";
      return null;
    case "heartbeat":
    case "heartbeat_ack":
      return null;
    case "shutdown":
      return str((f as Record<string, unknown>).reason, 256) ? null : "shutdown.reason invalid";
    case "error":
      return str((f as Record<string, unknown>).code, 64) ? null : "error.code invalid";
    default:
      return `unknown server frame: ${t}`;
  }
}

export function asClientFrame(u: unknown): ClientFrame {
  return u as ClientFrame;
}

export function asServerFrame(u: unknown): ServerFrame {
  return u as ServerFrame;
}
