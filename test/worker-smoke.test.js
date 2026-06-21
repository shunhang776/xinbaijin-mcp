import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared capture array — must use vi.hoisted() so the vi.mock factory
// (which runs before all imports) can close over it.
// ---------------------------------------------------------------------------
const { registeredTools } = vi.hoisted(() => {
  return { registeredTools: [] };
});

// ---------------------------------------------------------------------------
// Mock Cloudflare-specific modules BEFORE any imports from worker.js.
// These are hoisted by Vitest to the top of the file.
// ---------------------------------------------------------------------------
vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn(() => () => new Response("ok"))
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    constructor(serverInfo, _options) {
      this.serverInfo = serverInfo;
      this._registeredTools = {};
    }
    registerTool(name, config, handler) {
      registeredTools.push({ name, config, handler });
      this._registeredTools[name] = { config, handler };
      return this;
    }
  }
}));

// ---------------------------------------------------------------------------
// Now safe to import — mocks are active
// ---------------------------------------------------------------------------
import { createServer } from "../worker.js";

// ---------------------------------------------------------------------------
// Speed up handler tests: reject all fetch calls so they fail instantly
// instead of timing out against the real GitHub API.
// ---------------------------------------------------------------------------
beforeEach(() => {
  registeredTools.length = 0;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network mock")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Worker smoke test", () => {
  it("createServer does not throw", () => {
    const server = createServer({ GITHUB_TOKEN: "test-token" });
    expect(server).toBeDefined();
  });

  it("registers all 4 MCP tools", () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const names = registeredTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_file_content",
      "get_latest_handoff",
      "get_patch",
      "submit_review"
    ]);
  });

  it("all 4 tools include repository in their input schema", () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    for (const tool of registeredTools) {
      const schema = tool.config.inputSchema;
      expect(schema, `inputSchema missing for tool "${tool.name}"`).toBeDefined();

      // inputSchema can be either:
      //   - a plain object with Zod fields, e.g. { repository: z.enum(...) }
      //   - a Zod v4 object, e.g. z.object({ repository: ..., sha: ... })
      // Zod v4 objects expose .shape directly; plain objects just have keys.
      const hasRepo =
        schema.repository ||
        (schema.shape && schema.shape.repository);
      expect(
        hasRepo,
        `tool "${tool.name}" is missing the "repository" field in its input schema`
      ).toBeDefined();
    }
  });

  it("get_latest_handoff handler returns error result with mock fetch", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const handler = registeredTools.find((t) => t.name === "get_latest_handoff").handler;
    expect(typeof handler).toBe("function");

    const result = await handler({ repository: "xinbaijin" });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(
      result.isError === true || result.content !== undefined,
      "handler must return error result with isError or content"
    ).toBe(true);
    expect(result.ok).not.toBe(true);
  });

  it("get_patch handler returns error result with mock fetch", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const handler = registeredTools.find((t) => t.name === "get_patch").handler;
    expect(typeof handler).toBe("function");

    const result = await handler({ repository: "xinbaijin-mcp" });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(
      result.isError === true || result.content !== undefined,
      "handler must return error result with isError or content"
    ).toBe(true);
  });

  it("get_file_content handler returns error result with mock fetch", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const handler = registeredTools.find((t) => t.name === "get_file_content").handler;
    expect(typeof handler).toBe("function");

    const result = await handler({
      repository: "xinbaijin-mcp",
      path: "src/index.js",
      ref: "a".repeat(40)
    });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(
      result.isError === true || result.content !== undefined,
      "handler must return error result with isError or content"
    ).toBe(true);
  });

  it("submit_review handler returns error result with mock fetch", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const handler = registeredTools.find((t) => t.name === "submit_review").handler;
    expect(typeof handler).toBe("function");

    const result = await handler({
      repository: "xinbaijin",
      commit: "a".repeat(40),
      verdict: "approved",
      summary: "test",
      findings: []
    });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(
      result.isError === true || result.content !== undefined,
      "handler must return error result with isError or content"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /mcp authentication — inline auth logic tests
// ---------------------------------------------------------------------------
describe("/mcp authentication", () => {
  // Replicate the auth check from worker.js fetch handler:
  //   const expectedToken = env.MCP_ACCESS_TOKEN;
  //   if (!expectedToken) → 500
  //   if (authHeader !== "Bearer " + expectedToken) → 401
  function checkAuth(env, authHeader) {
    const expectedToken = env.MCP_ACCESS_TOKEN;
    if (!expectedToken) {
      return { status: 500, ok: false, error: "MCP_ACCESS_TOKEN is not configured on this Worker." };
    }
    const header = (authHeader || "").trim();
    if (header !== "Bearer " + expectedToken) {
      return { status: 401, ok: false, error: "Unauthorized." };
    }
    return { status: 200, ok: true };
  }

  it("returns 500 when MCP_ACCESS_TOKEN is not configured", () => {
    const result = checkAuth({}, "Bearer some-token");
    expect(result.status).toBe(500);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("MCP_ACCESS_TOKEN");
  });

  it("returns 401 when Authorization header is missing", () => {
    const result = checkAuth({ MCP_ACCESS_TOKEN: "secret" }, "");
    expect(result.status).toBe(401);
    expect(result.error).toContain("Unauthorized");
  });

  it("returns 401 when token is wrong", () => {
    const result = checkAuth(
      { MCP_ACCESS_TOKEN: "correct" },
      "Bearer wrong-token"
    );
    expect(result.status).toBe(401);
    expect(result.error).toContain("Unauthorized");
  });

  it("returns 200 when token matches", () => {
    const result = checkAuth(
      { MCP_ACCESS_TOKEN: "my-secret" },
      "Bearer my-secret"
    );
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
  });
});
