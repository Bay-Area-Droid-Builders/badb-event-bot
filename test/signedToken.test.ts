import { beforeEach, describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/signedToken";

const NOW = 1_800_000_000_000;

describe("signed tokens", () => {
  beforeEach(() => {
    process.env.RSVP_SIGNING_SECRET = "test-secret";
  });

  it("round-trips a payload", () => {
    const token = signToken({ email: "r2@example.com" }, 1000, NOW);

    expect(verifyToken(token, NOW + 999)).toEqual({ email: "r2@example.com", exp: NOW + 1000 });
  });

  it("rejects an expired token", () => {
    const token = signToken({ email: "r2@example.com" }, 1000, NOW);

    expect(verifyToken(token, NOW + 1001)).toBeUndefined();
  });

  it("rejects a token whose payload was edited", () => {
    const [, sig] = signToken({ email: "r2@example.com" }, 1000, NOW).split(".");
    const forgedBody = Buffer.from(JSON.stringify({ email: "victim@example.com", exp: NOW + 1000 })).toString("base64url");

    expect(verifyToken(`${forgedBody}.${sig}`, NOW)).toBeUndefined();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken({ email: "r2@example.com" }, 1000, NOW);
    process.env.RSVP_SIGNING_SECRET = "other-secret";

    expect(verifyToken(token, NOW)).toBeUndefined();
  });

  it("rejects malformed input", () => {
    expect(verifyToken(undefined)).toBeUndefined();
    expect(verifyToken("")).toBeUndefined();
    expect(verifyToken("abc")).toBeUndefined();
    expect(verifyToken("a.b.c")).toBeUndefined();
  });
});
