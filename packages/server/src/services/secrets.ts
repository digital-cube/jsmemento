import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url: the value of a session cookie or of a mail token. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex: what is stored for a session cookie or a mail token. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
