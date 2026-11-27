import { describe, expect, test } from "bun:test";
import { TokenVerifier } from "./auth";
import {
  OWNER_ADMIN,
  OWNER_BASE,
  actorName,
  authenticate,
  authorize,
  authorizeEditSource,
  brainDenied,
  meResponse,
  type Actor,
  type PermClass,
} from "./authz";

// The authorizer is ONE exhaustive switch over the route classes. These
// matrices are the contract: for a named token the answer is deny unless
// the sheet says otherwise; the owner's env tokens keep every class.

const NAMED = (sheet: Partial<Actor> = {}): Actor => ({
  kind: "token",
  name: "张三",
  tokenId: "tk_0123456789ab",
  brains: ["bip"],
  adjudicate: false,
  editSources: [],
  ...sheet,
});

const CLASSES: readonly PermClass[] = ["view", "adjudicate", "edit", "owner-only"];

describe("authorize (class × caller)", () => {
  test("a view-only named token gets exactly the view class", () => {
    const who = NAMED();
    expect(authorize(who, "view")).toBeNull();
    expect(authorize(who, "adjudicate")).toEqual({ missing: "adjudicate" });
    expect(authorize(who, "edit")).toEqual({ missing: "edit" });
    expect(authorize(who, "owner-only")).toEqual({ missing: "owner-only" });
  });

  test("the adjudicate grant opens the adjudicate class and nothing else", () => {
    const who = NAMED({ adjudicate: true });
    for (const perm of CLASSES) {
      expect(authorize(who, perm)).toEqual(
        perm === "view" || perm === "adjudicate" ? null : { missing: perm },
      );
    }
  });

  test("the owner's env tokens keep every class (the admin tier is checked by the management routes)", () => {
    for (const perm of CLASSES) {
      expect(authorize(OWNER_BASE, perm)).toBeNull();
      expect(authorize(OWNER_ADMIN, perm)).toBeNull();
    }
  });

  test("a malformed sheet entry never widens access", () => {
    expect(authorize(NAMED({ adjudicate: undefined }), "adjudicate")).toEqual({
      missing: "adjudicate",
    });
    // @ts-expect-error — simulating a sheet value that is truthy but not true
    expect(authorize(NAMED({ adjudicate: "yes" }), "adjudicate")).toEqual({
      missing: "adjudicate",
    });
  });
});

describe("authorizeEditSource (R2, ready for step 2)", () => {
  test("env tokens may edit any source", () => {
    expect(authorizeEditSource(OWNER_BASE, "metadata")).toBeNull();
    expect(authorizeEditSource(OWNER_BASE, undefined)).toBeNull();
  });
  test("a named token edits only the sources on its sheet", () => {
    const who = NAMED({ editSources: ["metadata"] });
    expect(authorizeEditSource(who, "metadata")).toBeNull();
    expect(authorizeEditSource(who, "yon-bip")).toEqual({
      missing: "edit",
      source: "yon-bip",
    });
    expect(authorizeEditSource(who, undefined)).toEqual({ missing: "edit" });
  });
});

describe("brainDenied", () => {
  test("env tokens enter any brain", () => {
    expect(brainDenied(OWNER_BASE, "atlas", true)).toBeNull();
    expect(brainDenied(OWNER_ADMIN, "ghost", false)).toBeNull();
  });
  test("a named token enters only the brains on its sheet", () => {
    const who = NAMED();
    expect(brainDenied(who, "bip", true)).toBeNull();
    expect(brainDenied(who, "atlas", true)).toEqual({ missing: "brain" });
  });
  test("a brain that is not on the sheet and a brain that does not exist answer identically", () => {
    const who = NAMED();
    expect(brainDenied(who, "atlas", true)).toEqual(brainDenied(who, "ghost", false));
    expect(brainDenied(who, "atlas", true)).toEqual(brainDenied(who, "atlas", false));
  });
});

describe("authenticate", () => {
  const verifier = new TokenVerifier({ base: "base-token", admin: "admin-token" });

  test("without a registry only the env tokens authenticate", () => {
    expect(authenticate(verifier, null, "Bearer base-token")).toEqual(OWNER_BASE);
    expect(authenticate(verifier, null, "Bearer admin-token")).toEqual(OWNER_ADMIN);
    expect(authenticate(verifier, null, "Bearer ck_x")).toBeNull();
    expect(authenticate(verifier, null, null)).toBeNull();
  });

  test("the env verifier keeps its 0.6 shape", () => {
    expect(verifier.verify("Bearer base-token")).toEqual({ name: "owner", tier: "base" });
    expect(verifier.verify("Bearer admin-token")).toEqual({ name: "owner", tier: "admin" });
  });
});

describe("actorName and meResponse", () => {
  test("the audit strings of 0.6 are preserved; undefined reads as the owner", () => {
    expect(actorName(OWNER_BASE)).toBe("owner");
    expect(actorName(OWNER_ADMIN)).toBe("owner (admin)");
    expect(actorName(undefined)).toBe("owner");
    expect(actorName(NAMED())).toBe("张三");
  });

  test("the owner's sheet is everything; a named token's is its own", () => {
    const owner = meResponse(OWNER_ADMIN, {
      adminConfigured: true,
      brains: ["atlas", "bip"],
      tokensWired: true,
    });
    expect(owner.kind).toBe("owner");
    expect(owner.permissions).toEqual({
      adjudicate: true,
      editSources: "all",
      ops: true,
      paidThink: true,
      tokens: true,
      tokensWrite: true,
    });
    expect(owner.defaultBrain).toBe("atlas");

    const base = meResponse(OWNER_BASE, {
      adminConfigured: true,
      brains: ["atlas"],
      tokensWired: true,
    });
    expect(base.permissions.tokens).toBe(true);
    expect(base.permissions.tokensWrite).toBe(false);

    const named = meResponse(NAMED({ adjudicate: true }), {
      adminConfigured: true,
      brains: ["atlas", "bip"],
      tokensWired: true,
    });
    expect(named).toEqual({
      kind: "token",
      name: "张三",
      // a deployment detail of the owner's UI, withheld from a named token
      adminConfigured: false,
      brains: ["bip"],
      defaultBrain: "bip",
      permissions: {
        adjudicate: true,
        editSources: [],
        ops: false,
        paidThink: false,
        tokens: false,
        tokensWrite: false,
      },
    });
  });
});
