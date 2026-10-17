import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";

function scryptP(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

/**
 * Password hashing with scrypt (Node builtin, no native deps).
 * Format: "scrypt$v1$<saltHex>$<hashHex>" with N=16384,r=8,p=1,dkLen=64.
 * Rationale (see DECISIONS.md): argon2 needs native builds and blows the
 * 1 GB/day data budget; scrypt with these params is a maintained,
 * memory-hard KDF available in every Node LTS.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (password.length > 256) throw new Error("Password too long.");
  const salt = randomBytes(16);
  const hash = await scryptP(password, salt, 64);
  return `scrypt$v1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptP(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
