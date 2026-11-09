import { describe, expect, test } from "bun:test";
import { TokenVerifier, hasTokenInQuery } from "./auth";

const TOKEN = "cockpit-secret-token";
const ADMIN = "cockpit-admin-secret";

describe("TokenVerifier", () => {
  const verifier = new TokenVerifier({ base: TOKEN });

  test("accepts the exact bearer token and returns the owner principal", () => {
    expect(verifier.verify(`Bearer ${TOKEN}`)).toEqual({
      name: "owner",
      tier: "base",
    });
  });

  test("rejects wrong token, missing header, and malformed header", () => {
    expect(verifier.verify("Bearer wrong-token")).toBeNull();
    expect(verifier.verify(null)).toBeNull();
    expect(verifier.verify("")).toBeNull();
    expect(verifier.verify(TOKEN)).toBeNull(); // scheme missing
    expect(verifier.verify(`Basic ${TOKEN}`)).toBeNull();
    expect(verifier.verify(`bearer ${TOKEN}`)).toBeNull(); // scheme is case-sensitive per RFC 7235 usage here
  });

  test("without an admin token the base token is the only tier", () => {
    expect(verifier.adminConfigured).toBe(false);
    expect(verifier.verify(`Bearer ${ADMIN}`)).toBeNull();
  });
});

describe("TokenVerifier (two tiers, D6 amendment)", () => {
  const verifier = new TokenVerifier({ base: TOKEN, admin: ADMIN });

  test("admin token verifies as the admin tier", () => {
    expect(verifier.adminConfigured).toBe(true);
    expect(verifier.verify(`Bearer ${ADMIN}`)).toEqual({
      name: "owner",
      tier: "admin",
    });
  });

  test("base token still verifies as base — the split never widens reads", () => {
    expect(verifier.verify(`Bearer ${TOKEN}`)).toEqual({
      name: "owner",
      tier: "base",
    });
  });

  test("unknown tokens still fail closed", () => {
    expect(verifier.verify("Bearer nope")).toBeNull();
  });
});

describe("hasTokenInQuery", () => {
  test("flags token-like query params", () => {
    expect(hasTokenInQuery(new URL("http://x/healthz?token=abc"))).toBe(true);
    expect(hasTokenInQuery(new URL("http://x/healthz?access_token=abc"))).toBe(
      true,
    );
    expect(hasTokenInQuery(new URL("http://x/healthz?X-Token=abc"))).toBe(true);
  });

  test("lets ordinary params through", () => {
    expect(hasTokenInQuery(new URL("http://x/healthz"))).toBe(false);
    expect(hasTokenInQuery(new URL("http://x/healthz?force=1&lang=zh"))).toBe(
      false,
    );
  });
});
