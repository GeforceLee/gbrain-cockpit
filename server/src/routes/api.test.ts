import { describe, expect, test } from "bun:test";
import { CliExecutionError, CliValidationError } from "../drivers/cli";
import { McpError } from "../drivers/mcp";
import { BadRequestError } from "../http";
import { mapError } from "./api";

// mapError is the single error surface every /api route funnels through
// (index.ts catch-all). The contract that matters: validation failures are
// 400s, upstream (MCP/CLI) failures are 502/504 with the bounded upstream
// message, and only truly unexpected errors degrade to an opaque 500.

describe("mapError", () => {
  test("validation errors are 400 E_BAD_REQUEST", async () => {
    for (const err of [new BadRequestError("bad id"), new CliValidationError("takes propose accept: invalid id \"x\"")]) {
      const res = mapError(err);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("E_BAD_REQUEST");
      expect(body.error).toBe(err.message);
    }
  });

  test("CLI execution failure is 502 E_UPSTREAM carrying the stderr first line", async () => {
    const err = new CliExecutionError(
      "takes propose accept failed: No brain directory configured. Pass --dir <path> or run `gbrain init` first.",
      1,
    );
    const res = mapError(err);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_UPSTREAM");
    expect(body.error).toContain("No brain directory configured");
  });

  test("CLI timeout is 504 E_UPSTREAM", async () => {
    const res = mapError(new CliExecutionError("takes propose accept: timed out", undefined, true));
    expect(res.status).toBe(504);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("E_UPSTREAM");
  });

  test("MCP auth error stays 502 E_UPSTREAM_AUTH", async () => {
    const res = mapError(new McpError("auth", "token rejected"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("E_UPSTREAM_AUTH");
  });

  test("unknown errors degrade to 500 E_INTERNAL without leaking the message", async () => {
    const res = mapError(new Error("postgres went sideways: secret-dsn"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_INTERNAL");
    expect(body.error).not.toContain("secret-dsn");
  });
});
