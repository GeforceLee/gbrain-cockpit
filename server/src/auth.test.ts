import { describe, expect, test } from "bun:test";
import { TokenVerifier, hasTokenInQuery } from "./auth";

const TOKEN = "cockpit-secret-token";

describe("TokenVerifier", () => {
  const verifier = new TokenVerifier(TOKEN);

  test("accepts the exact bearer token and returns the owner principal", () => {
    expect(verifier.verify(`Bearer ${TOKEN}`)).toEqual({ name: "owner" });
  });

  test("rejects wrong token, missing header, and malformed header", () => {
    expect(verifier.verify("Bearer wrong-token")).toBeNull();
    expect(verifier.verify(null)).toBeNull();
    expect(verifier.verify("")).toBeNull();
    expect(verifier.verify(TOKEN)).toBeNull(); // scheme missing
    expect(verifier.verify(`Basic ${TOKEN}`)).toBeNull();
    expect(verifier.verify(`bearer ${TOKEN}`)).toBeNull(); // scheme is case-sensitive per RFC 7235 usage here
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
