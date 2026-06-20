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

  it("get_latest_handoff handler returns structured result with repository", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const tools = Object.fromEntries(registeredTools.map((t) => [t.name, t.handler]));
    const handoffHandler = tools["get_latest_handoff"];
    expect(typeof handoffHandler).toBe("function");

    try {
      const result = await handoffHandler({ repository: "xinbaijin" });
      // Since fetch is mocked to reject, the handler's try/catch should
      // return an error object rather than throwing.
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    } catch (e) {
      // Only fail if a ReferenceError / "is not defined" slipped through
      expect(e.message, `get_latest_handoff threw ReferenceError: ${e.message}`).not.toMatch(
        /is not defined/
      );
    }
  });

  it("submit_review handler validates with complete input", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const tools = Object.fromEntries(registeredTools.map((t) => [t.name, t.handler]));
    const submitHandler = tools["submit_review"];
    expect(typeof submitHandler).toBe("function");

    try {
      const result = await submitHandler({
        repository: "xinbaijin",
        commit: "a".repeat(40),
        verdict: "approved",
        summary: "test",
        findings: []
      });
      // Any structured return is acceptable (error or success)
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    } catch (e) {
      expect(e.message, `submit_review threw ReferenceError: ${e.message}`).not.toMatch(
        /is not defined/
      );
    }
  });

  it("get_file_content handler validates with complete input", async () => {
    createServer({ GITHUB_TOKEN: "test-token" });
    const tools = Object.fromEntries(registeredTools.map((t) => [t.name, t.handler]));
    const fileHandler = tools["get_file_content"];
    expect(typeof fileHandler).toBe("function");

    try {
      const result = await fileHandler({
        repository: "xinbaijin-mcp",
        path: "src/index.js",
        ref: "a".repeat(40)
      });
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    } catch (e) {
      expect(e.message, `get_file_content threw ReferenceError: ${e.message}`).not.toMatch(
        /is not defined/
      );
    }
  });
});
