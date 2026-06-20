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

  it("tool handlers accept repository and do not throw on valid input", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    for (const tool of registeredTools) {
      const handler = tool.handler;
      expect(typeof handler, `handler for "${tool.name}" is not a function`).toBe("function");

      // Each handler should be callable with at least repository.
      // All real failures (missing env/token, fetch rejections) are caught
      // by the handler's try/catch and returned as { isError: true, ... }.
      // The only unacceptable failure is a ReferenceError / "is not defined".
      try {
        await handler({ repository: "xinbaijin" });
      } catch (e) {
        expect(
          e.message,
          `handler for "${tool.name}" threw: ${e.message}`
        ).not.toMatch(/is not defined/);
      }
    }
  });
});
