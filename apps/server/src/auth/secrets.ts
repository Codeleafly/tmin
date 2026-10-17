import { randomBytes, createHash, createHmac } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Opaque bearer token: "tmin_<26 random chars>". Only hash is stored. */
export function newBearerToken(): { secret: string; prefix: string; hash: string } {
  const rand = randomBytes(20).toString("base64url");
  const secret = `tmin_${rand}`;
  const prefix = `tm_${rand.slice(0, 8)}`;
  const hash = sha256Hex(secret);
  return { secret, prefix, hash };
}

export function newSessionToken(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: sha256Hex(secret) };
}

export function anonPathToken(): string {
  // Lowercase hex only: paths are case-normalized by the router.
  return `a-${randomBytes(6).toString("hex")}`;
}

export function ipHash(ip: string, pepper: string): string {
  return createHmac("sha256", pepper || "tmin-pepper").update(ip).digest("hex").slice(0, 32);
}
