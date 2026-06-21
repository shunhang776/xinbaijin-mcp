import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Simulated safe handler pattern — mirrors what worker.js uses
// ---------------------------------------------------------------------------
const REPOSITORIES = Object.freeze({
  xinbaijin: { owner: "shunhang776", repo: "xinbaijin", branch: "dev" },
  "xinbaijin-mcp": { owner: "shunhang776", repo: "xinbaijin-mcp", branch: "dev" }
});
const DEFAULT_REPOSITORY = "xinbaijin";

function safeHandler(tool, args, businessLogic) {
  try {
    console.error(JSON.stringify({
      tool,
      typeofArgs: typeof args,
      argKeys: args ? Object.keys(args) : [],
      repository: args?.repository
    }));

    const repository = args?.repository || DEFAULT_REPOSITORY;

    if (!REPOSITORIES[repository]) {
      return {
        isError: true,
        content: [{ type: "text", text: "Unknown repository: " + repository + ". Allowed: " + Object.keys(REPOSITORIES).join(", ") }]
      };
    }

    return businessLogic(repository, args);
  } catch (error) {
    console.error(tool + " error:", error.name, error.message);
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
    };
  }
}

// ---------------------------------------------------------------------------
describe("handler safety — no Worker 502", () => {
  const okLogic = (repo) => ({ content: [{ type: "text", text: "ok repo=" + repo }] });
  const boomLogic = () => { throw new Error("boom"); };

  it("explicit repository xinbaijin-mcp", () => {
    const r = safeHandler("test", { repository: "xinbaijin-mcp" }, okLogic);
    expect(r.content[0].text).toContain("xinbaijin-mcp");
    expect(r.isError).toBeUndefined();
  });

  it("explicit repository xinbaijin", () => {
    const r = safeHandler("test", { repository: "xinbaijin" }, okLogic);
    expect(r.content[0].text).toContain("xinbaijin");
    expect(r.isError).toBeUndefined();
  });

  it("omitted repository defaults to xinbaijin", () => {
    const r = safeHandler("test", {}, okLogic);
    expect(r.content[0].text).toContain("xinbaijin");
    expect(r.isError).toBeUndefined();
  });

  it("undefined repository → no 502", () => {
    const r = safeHandler("test", { repository: undefined }, okLogic);
    expect(r.content[0].text).toContain("xinbaijin");
    expect(r.isError).toBeUndefined();
  });

  it("null repository → no 502", () => {
    const r = safeHandler("test", { repository: null }, okLogic);
    expect(r.content[0].text).toContain("xinbaijin");
    expect(r.isError).toBeUndefined();
  });

  it("args is undefined → no 502", () => {
    const r = safeHandler("test", undefined, okLogic);
    expect(r.content[0].text).toContain("xinbaijin");
    expect(r.isError).toBeUndefined();
  });

  it("non-whitelist repository → controlled error", () => {
    const r = safeHandler("test", { repository: "evil" }, okLogic);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Unknown repository");
  });

  it("business logic throw → controlled error (no 502)", () => {
    const r = safeHandler("test", { repository: "xinbaijin" }, boomLogic);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("boom");
  });

  it("all 4 tools safe with omitted repository", () => {
    for (const tool of ["get_latest_handoff", "get_patch", "get_file_content", "submit_review"]) {
      const r = safeHandler(tool, {}, okLogic);
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain("xinbaijin");
    }
  });

  it("all 4 tools safe with undefined args", () => {
    for (const tool of ["get_latest_handoff", "get_patch", "get_file_content", "submit_review"]) {
      const r = safeHandler(tool, undefined, okLogic);
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain("xinbaijin");
    }
  });

  it("all 4 tools return controlled error on throw", () => {
    for (const tool of ["get_latest_handoff", "get_patch", "get_file_content", "submit_review"]) {
      const r = safeHandler(tool, { repository: "xinbaijin" }, boomLogic);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("boom");
    }
  });
});

// ---------------------------------------------------------------------------
describe("handler arg logging — no secrets", () => {
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

  it("log contains structural metadata only", () => {
    safeHandler("get_latest_handoff", { repository: "xinbaijin-mcp" }, () => ({}));
    const logged = JSON.parse(consoleErrors[0]);
    expect(logged.tool).toBe("get_latest_handoff");
    expect(logged.typeofArgs).toBe("object");
    expect(logged.argKeys).toContain("repository");
  });

  it("log NEVER contains token or secret", () => {
    safeHandler("get_patch", { repository: "xinbaijin", sha: "abc" }, () => ({}));
    for (const entry of consoleErrors) {
      const s = typeof entry === "string" ? entry : JSON.stringify(entry);
      expect(s).not.toContain("token");
      expect(s).not.toContain("Token");
      expect(s).not.toContain("Bearer");
      expect(s).not.toContain("Authorization");
      expect(s).not.toContain("GITHUB_TOKEN");
      expect(s).not.toContain("MCP_ACCESS_TOKEN");
    }
  });
});
