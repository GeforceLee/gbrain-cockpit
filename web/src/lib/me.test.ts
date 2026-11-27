import { describe, expect, test } from "bun:test";
import type { MeResponse } from "@gbrain-cockpit/shared";
import { ApiError } from "./api";
import { canEditSource, getMe, isOwner, setMe } from "./me";
import { errorMessage, forbiddenMessage, stepUpErrorMessage } from "./errors";

// The web side of the permission sheet (0.7): what "who am I" lets a panel
// show, and how a refusal reads in plain language.

const OWNER: MeResponse = {
  kind: "owner",
  name: "owner",
  adminConfigured: true,
  brains: ["atlas", "bip"],
  defaultBrain: "atlas",
  permissions: {
    adjudicate: true,
    editSources: "all",
    ops: true,
    paidThink: true,
    tokens: true,
    tokensWrite: true,
  },
};

const VIEWER: MeResponse = {
  kind: "token",
  name: "张三",
  adminConfigured: true,
  brains: ["bip"],
  defaultBrain: "bip",
  permissions: {
    adjudicate: false,
    editSources: [],
    ops: false,
    paidThink: false,
    tokens: false,
    tokensWrite: false,
  },
};

/** a `t` that answers with the key, so assertions can name keys */
const t = (key: string) => key;

describe("me store", () => {
  test("nobody resolved yet: not the owner, and nothing is editable", () => {
    setMe(null);
    expect(getMe()).toBeNull();
    expect(isOwner()).toBe(false);
    expect(canEditSource("metadata")).toBe(false);
  });

  test("the owner may edit any source, with or without a known source", () => {
    setMe(OWNER);
    expect(isOwner()).toBe(true);
    expect(canEditSource("metadata")).toBe(true);
    expect(canEditSource(undefined)).toBe(true);
  });

  test("a named token edits only the sources on its sheet", () => {
    setMe(VIEWER);
    expect(isOwner()).toBe(false);
    expect(canEditSource("metadata")).toBe(false);
    setMe({
      ...VIEWER,
      permissions: { ...VIEWER.permissions, editSources: ["metadata"] },
    });
    expect(canEditSource("metadata")).toBe(true);
    expect(canEditSource("yon-bip")).toBe(false);
    expect(canEditSource("default")).toBe(false);
  });

  test("getMe mirrors the last answer", () => {
    setMe(VIEWER);
    expect(getMe()?.name).toBe("张三");
    setMe(null);
    expect(getMe()).toBeNull();
  });
});

describe("plain-language refusals", () => {
  test("each missing grant has its own line", () => {
    expect(forbiddenMessage("adjudicate", undefined, t)).toBe("error.forbidden.adjudicate");
    expect(forbiddenMessage("edit", undefined, t)).toBe("error.forbidden.edit");
    expect(forbiddenMessage("edit", "yon-bip", t)).toBe("error.forbidden.editSource");
    expect(forbiddenMessage("brain", undefined, t)).toBe("error.forbidden.brain");
    expect(forbiddenMessage("owner-only", undefined, t)).toBe("error.forbidden.ownerOnly");
  });

  test("the source is named in the line", () => {
    const say = (key: string) =>
      ({ "error.forbidden.editSource": "你的访问令牌没有改「{source}」这个来源的权限。" })[key] ??
      key;
    expect(forbiddenMessage("edit", "yon-bip", say)).toBe(
      "你的访问令牌没有改「yon-bip」这个来源的权限。",
    );
  });

  test("errorMessage routes a 403 with a missing grant to its line", () => {
    const err = new ApiError("server words", "E_FORBIDDEN", 403, { missing: "owner-only" });
    expect(errorMessage(err, t)).toBe("error.forbidden.ownerOnly");
  });

  test("a failed admin-token paste never reads as an expired session", () => {
    const wrong = new ApiError("missing or invalid bearer token", "E_UNAUTHENTICATED", 401, {
      credential: "step-up",
    });
    expect(stepUpErrorMessage(wrong, t)).toBe("admin.stepUp.invalid");
    const notAdmin = new ApiError("x", "E_FORBIDDEN", 403, {
      credential: "step-up",
      missing: "admin-tier",
      raw: "token management requires the COCKPIT_ADMIN_TOKEN tier",
    });
    expect(stepUpErrorMessage(notAdmin, t)).toBe("admin.stepUp.notAdmin");
    // a plain 403 with no marker keeps the generic line — no marker, no guess
    expect(stepUpErrorMessage(new ApiError("x", "E_FORBIDDEN", 403), t)).toBe("x");
    // other failures keep the ordinary mapping (here unmapped: the raw line)
    const broken = new ApiError("boom", "E_INTERNAL", 500, { credential: "step-up" });
    expect(stepUpErrorMessage(broken, t)).toBe("boom");
    expect(stepUpErrorMessage(new Error("offline"), t)).toBe("offline");
  });

  test("which credential a request used is carried on the error", () => {
    expect(new ApiError("x", "E_HTTP", 500).extra.credential).toBeUndefined();
    expect(
      new ApiError("x", "E_HTTP", 500, { credential: "session" }).extra.credential,
    ).toBe("session");
  });
});

describe("the role is never guessed (web side)", () => {
  test("no identity at all is its own state — neither owner nor named", async () => {
    const { role, hasPaidThink } = await import("./me");
    setMe(null);
    expect(role()).toBe("unknown");
    expect(isOwner()).toBe(false);
    expect(hasPaidThink()).toBe(false);
    expect(canEditSource("default")).toBe(false);
    setMe(VIEWER);
    expect(role()).toBe("named");
    expect(hasPaidThink()).toBe(false);
    setMe(OWNER);
    expect(role()).toBe("owner");
    expect(hasPaidThink()).toBe(true);
  });
});

describe("the name rules, mirrored from the server", () => {
  test("a colleague's name passes; impersonations and odd characters do not", async () => {
    const { checkTokenName, nameSkeleton } = await import("./tokenName");
    expect(checkTokenName("张三")).toBeNull();
    expect(checkTokenName("Zhang San")).toBeNull();
    expect(checkTokenName("li.si·wang")).toBeNull();
    expect(checkTokenName("Owner")).toBe("reserved");
    expect(checkTokenName("adm1n")).toBe("reserved");
    expect(checkTokenName("0wner")).toBe("reserved");
    expect(checkTokenName("José")).toBe("shape");
    expect(checkTokenName("张\u3164三")).toBe("shape");
    expect(checkTokenName("")).toBe("shape");
    expect(checkTokenName("12345")).toBe("shape");
    expect(checkTokenName("root")).toBe("reserved");
    expect(checkTokenName("管理员")).toBe("reserved");
    expect(nameSkeleton("admln")).toBe("admin");
  });
});

describe("every mapped code reads in plain language, the server's words kept as raw", () => {
  test("the display line is built from raw, so it is stable when re-mapped", () => {
    const say = (key: string) =>
      ({ "error.E_UPSTREAM": "知识库暂时没有回应" })[key] ?? key;
    const err = new ApiError("知识库暂时没有回应 · boom", "E_UPSTREAM", 502, {
      credential: "session",
      raw: "boom",
    });
    expect(errorMessage(err, say)).toBe("知识库暂时没有回应 · boom");
    // a 401 that reaches a panel is about the session, not a step-up
    const zh = (key: string) =>
      ({ "error.E_UNAUTHENTICATED": "访问令牌无效或已被作废,请重新登录" })[key] ?? key;
    expect(errorMessage(new ApiError("访问令牌无效或已被作废,请重新登录", "E_UNAUTHENTICATED", 401), zh)).toBe(
      "访问令牌无效或已被作废,请重新登录",
    );
    expect(
      errorMessage(
        new ApiError("访问令牌无效或已被作废,请重新登录 · server words", "E_UNAUTHENTICATED", 401, {
          raw: "server words",
        }),
        zh,
      ),
    ).toBe("访问令牌无效或已被作废,请重新登录 · server words");
  });
});
