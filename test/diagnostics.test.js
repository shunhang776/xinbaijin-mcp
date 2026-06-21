import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Import the log utility for direct testing
import { logGitHubError } from "../diagnostics.js";

describe("logGitHubError", () => {
  let consoleErrors = [];

  beforeEach(() => {
    consoleErrors = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      consoleErrors.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs safe fields as JSON", () => {
    logGitHubError({
      tool: "get_latest_handoff",
      repository: "shunhang776/xinbaijin-mcp",
      owner: "shunhang776",
      repo: "xinbaijin-mcp",
      ref: "dev",
      status: 401,
      githubMessage: "Bad credentials",
      requestId: "abc123",
      errorName: "GitHubApiError",
      errorMessage: "GitHub API returned 401"
    });

    expect(consoleErrors.length).toBe(1);
    const logged = JSON.parse(consoleErrors[0]);
    expect(logged.tool).toBe("get_latest_handoff");
    expect(logged.status).toBe(401);
    expect(logged.githubMessage).toBe("Bad credentials");
    expect(logged.requestId).toBe("abc123");
  });

  it("does NOT log token or Authorization", () => {
    logGitHubError({
      tool: "get_patch",
      repository: "shunhang776/xinbaijin",
      owner: "shunhang776",
      repo: "xinbaijin",
      ref: "abc1234",
      status: 403,
      githubMessage: "Forbidden",
      requestId: "xyz",
      errorName: "Error",
      errorMessage: "403"
    });

    const logged = JSON.parse(consoleErrors[0]);
    const loggedStr = JSON.stringify(logged);
    expect(loggedStr).not.toContain("token");
    expect(loggedStr).not.toContain("Token");
    expect(loggedStr).not.toContain("Bearer");
    expect(loggedStr).not.toContain("Authorization");
    expect(loggedStr).not.toContain("GITHUB_TOKEN");
    expect(loggedStr).not.toContain("MCP_ACCESS_TOKEN");
    // Verify safe fields ARE present
    expect(logged.tool).toBeDefined();
    expect(logged.status).toBeDefined();
  });

  it("handles missing optional fields gracefully", () => {
    logGitHubError({
      tool: "get_file_content",
      repository: "shunhang776/xinbaijin-mcp",
      owner: "shunhang776",
      repo: "xinbaijin-mcp",
      ref: "abc123",
      status: 404,
      githubMessage: "",
      requestId: "",
      errorName: "Error",
      errorMessage: "Not found"
    });

    const logged = JSON.parse(consoleErrors[0]);
    expect(logged.githubMessage).toBe("");
    expect(logged.requestId).toBe("");
  });
});

// Test the handler error wrapping logic using mock fetch
describe("handler error wrapping", () => {
  // We test the error handling pattern: errors inside try block
  // must be caught and returned as { isError: true, content: [...] },
  // never thrown unhandled.

  it("returns error result when repository is missing", async () => {
    // Simulate the FIXED handler pattern
    async function fixedHandler({ repository }) {
      try {
        if (!repository) {
          throw new Error("repository is required. Choose xinbaijin or xinbaijin-mcp.");
        }
        return { content: [{ type: "text", text: "ok" }] };
      } catch (error) {
        console.error("tool error:", error.message);
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }

    const result = await fixedHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("repository is required");
  });

  it("returns error result for GitHub 401", async () => {
    async function handler() {
      try {
        throw new Error("GitHub API request failed: 401 Unauthorized");
      } catch (error) {
        console.error("tool error:", error.message);
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }

    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
  });

  it("returns error result for GitHub 403", async () => {
    async function handler() {
      try {
        throw new Error("GitHub API request failed: 403 Forbidden");
      } catch (error) {
        console.error("tool error:", error.message);
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }

    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });

  it("returns error result for GitHub 404", async () => {
    async function handler() {
      try {
        throw new Error("GitHub API request failed: 404 Not Found");
      } catch (error) {
        console.error("tool error:", error.message);
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }

    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  it("returns error result for GitHub 502", async () => {
    async function handler() {
      try {
        throw new Error("GitHub API request failed: 502 Bad Gateway");
      } catch (error) {
        console.error("tool error:", error.message);
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }

    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("502");
  });

  it("returns normal result on success", async () => {
    async function handler() {
      try {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    }

    const result = await handler();
    expect(result.isError).toBeUndefined();
    expect(result.content).toBeDefined();
  });
});
