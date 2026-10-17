/**
 * Versioned tunnel protocol (JSON frames over one WebSocket).
 * Multiplexing: many public HTTP requests share one WS via requestId.
 * Chunking: bodies stream as base64 chunks (bounded, backpressured).
 */

export type ClientFrame =
  | { type: "hello"; protocolVersion: number; auth: { mode: "anonymous" } | { mode: "token"; token: string }; clientVersion: string }
  | { type: "register"; slot: number; localPort: number; target?: string }
  | { type: "heartbeat"; at: number }
  | { type: "response_head"; requestId: string; status: number; headers: Record<string, string> }
  | { type: "response_chunk"; requestId: string; data: string }
  | { type: "response_end"; requestId: string }
  | { type: "response_error"; requestId: string; code: string; message: string }
  | { type: "ws_opened"; requestId: string }
  | { type: "ws_frame"; requestId: string; data: string; binary: boolean }
  | { type: "ws_closed"; requestId: string; code: number }
  | { type: "bye" };

export type ServerFrame =
  | { type: "welcome"; protocolVersion: number; tunnelId: string; routePath: string; publicUrl: string; anonymous: boolean; expiresAt: number | null }
  | { type: "registered"; tunnelId: string; routePath: string; publicUrl: string; slot: number; anonymous: boolean; expiresAt: number | null; resumeToken?: string }
  | { type: "request_head"; requestId: string; method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean }
  | { type: "request_chunk"; requestId: string; data: string; last: boolean }
  | { type: "request_cancel"; requestId: string; reason: string }
  | { type: "ws_frame"; requestId: string; data: string; binary: boolean }
  | { type: "ws_close"; requestId: string; code: number }
  | { type: "heartbeat"; at: number }
  | { type: "heartbeat_ack"; at: number }
  | { type: "shutdown"; reason: string; reconnectMs: number }
  | { type: "error"; code: string; message: string; fatal: boolean };

export type AnyFrame = ClientFrame | ServerFrame;

export const CHUNK_BYTES = 48 * 1024; // raw bytes per base64 chunk target
export const MAX_CHUNKS_IN_FLIGHT = 32;

export function encodeChunk(buf: Buffer): string {
  return buf.toString("base64");
}

export function decodeChunk(b64: string, maxBytes: number): Buffer {
  if (b64.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    throw new Error("Chunk too large");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length > maxBytes) throw new Error("Chunk too large");
  return buf;
}
