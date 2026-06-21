import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared capture array — must use vi.hoisted() so the vi.mock factory
// (which runs before all imports) can close over it.
// ---------------------------------------------------------------------------
const { registeredTools, oauthProviderConfigs } = vi.hoisted(() => {
  return {
    registeredTools: [],
    oauthProviderConfigs: []
  };
});
// ---------------------------------------------------------------------------
// Mock Cloudflare-specific modules BEFORE any imports from worker.js.
// These are hoisted by Vitest to the top of the file.
// ---------------------------------------------------------------------------
vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn(() => () => new Response("ok"))
}));
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class MockOAuthProvider {
    constructor(config) {
      oauthProviderConfigs.push(config);
    }

    async fetch() {
      return new Response("oauth mock", {
        status: 200
      });
    }
  }
}));

vi.mock("../oauth/github-handler.ts", () => ({
  GitHubHandler: {
    fetch: vi.fn()
  }
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
// OAuth provider wiring
// ---------------------------------------------------------------------------
describe("OAuth provider configuration", () => {
  it("protects /mcp with the expected OAuth endpoints", () => {
    expect(oauthProviderConfigs).toHaveLength(1);

    const config = oauthProviderConfigs[0];

    expect(config.apiRoute).toBe("/mcp");
    expect(config.authorizeEndpoint).toBe("/authorize");
    expect(config.tokenEndpoint).toBe("/token");
    expect(config.clientRegistrationEndpoint).toBe("/register");
    expect(config.apiHandler).toBeDefined();
    expect(config.defaultHandler).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MCP tool safety annotations
// ---------------------------------------------------------------------------
describe("MCP tool safety annotations", () => {
  it("declares accurate safety annotations for all MCP tools", () => {
    createServer({ GITHUB_TOKEN: "test-token" });

    const tools = Object.fromEntries(
      registeredTools.map((tool) => [tool.name, tool])
    );

    for (const name of [
      "get_latest_handoff",
      "get_patch",
      "get_file_content"
    ]) {
      expect(tools[name].config.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      });
    }

    expect(tools.submit_review.config.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true
    });
  });
});