import { createHmac, timingSafeEqual } from "crypto";

// Small HMAC-signed tokens (like a minimal JWT) for the RSVP flow: the
// email confirmation link, the "remember me" cookie, and the link a Discord
// RSVP button hands out. Signing lets them carry who someone is without a
// database lookup, and a token can't be edited — say, to swap in someone
// else's email — without breaking the signature.

function secret(): string {
  const value = process.env.RSVP_SIGNING_SECRET;
  if (!value) throw new Error("RSVP_SIGNING_SECRET is not set");
  return value;
}

function signature(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signToken(payload: object, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString("base64url");
  return `${body}.${signature(body)}`;
}

// Returns the payload, or undefined if the token is malformed, tampered
// with, or expired.
export function verifyToken<T>(token: string | undefined, now = Date.now()): T | undefined {
  if (!token) return undefined;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return undefined;

  const expected = Buffer.from(signature(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < now) return undefined;
    return payload as T;
  } catch {
    return undefined;
  }
}
