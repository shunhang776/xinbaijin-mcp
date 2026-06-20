import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { REPOSITORIES, getRepositoryConfig, submitReview } from "../review-core.js";
import { REPOSITORY_PARAM } from "../mcp-schemas.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Group 1: MCP public entry points reject missing repository (FIX 1)
// ---------------------------------------------------------------------------

describe("MCP tool schemas require repository (no .optional())", () => {
  it("get_latest_handoff schema rejects missing repository", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("repository");
    }
  });

  it("get_patch schema rejects missing repository", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("get_file_content schema rejects missing repository", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("submit_review schema rejects missing repository", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("schema accepts valid repository value", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({ repository: "xinbaijin" });
    expect(result.success).toBe(true);
  });

  it("schema rejects invalid repository values", () => {
    const schema = z.object({ repository: REPOSITORY_PARAM });
    const result = schema.safeParse({ repository: "evil-repo" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2: getRepositoryConfig validation
// ---------------------------------------------------------------------------

describe("getRepositoryConfig", () => {
  const mockEnv = { GITHUB_TOKEN: "test-token" };

  it("resolves xinbaijin when repository is omitted (internal default preserved)", () => {
    const config = getRepositoryConfig(mockEnv);
    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin");
    expect(config.branch).toBe("dev");
    expect(config.token).toBe("test-token");
  });

  it("resolves xinbaijin-mcp when explicitly passed", () => {
    const config = getRepositoryConfig(mockEnv, "xinbaijin-mcp");
    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin-mcp");
    expect(config.branch).toBe("dev");
  });

  it("rejects non-whitelist repository", () => {
    expect(() => getRepositoryConfig(mockEnv, "evil-repo")).toThrow(
      /Unknown repository/
    );
  });

  it("treats empty string as omitted and falls back to default", () => {
    const config = getRepositoryConfig(mockEnv, "");
    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin");
    expect(config.branch).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// Group 3: REPOSITORIES whitelist structure
// ---------------------------------------------------------------------------

describe("REPOSITORIES whitelist", () => {
  it("contains exactly 2 repositories", () => {
    expect(Object.keys(REPOSITORIES)).toHaveLength(2);
    expect(REPOSITORIES.xinbaijin).toBeDefined();
    expect(REPOSITORIES["xinbaijin-mcp"]).toBeDefined();
  });

  it("both repos have the same owner", () => {
    expect(REPOSITORIES.xinbaijin.owner).toBe(
      REPOSITORIES["xinbaijin-mcp"].owner
    );
  });

  it("both repos have dev as default branch", () => {
    expect(REPOSITORIES.xinbaijin.branch).toBe("dev");
    expect(REPOSITORIES["xinbaijin-mcp"].branch).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// Group 4: Cross-repo isolation (string level)
// ---------------------------------------------------------------------------

describe("cross-repo isolation", () => {
  const mockEnv = { GITHUB_TOKEN: "test-token" };

  it("different repos return different repo values", () => {
    const cfg1 = getRepositoryConfig(mockEnv, "xinbaijin");
    const cfg2 = getRepositoryConfig(mockEnv, "xinbaijin-mcp");
    expect(cfg1.repo).not.toBe(cfg2.repo);
  });

  it("same repo returns consistent config", () => {
    const cfg1 = getRepositoryConfig(mockEnv, "xinbaijin");
    const cfg2 = getRepositoryConfig(mockEnv, "xinbaijin");
    expect(cfg1.repo).toBe(cfg2.repo);
    expect(cfg1.owner).toBe(cfg2.owner);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Cross-repo isolation with mocked fetch (end-to-end)
// ---------------------------------------------------------------------------

describe("submitReview uses single repository for entire call chain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeMockCommit = (sha, treeSha, isReviewOnly) => {
    const files = isReviewOnly
      ? [{ filename: "review.json" }]
      : [{ filename: "src/index.js" }];
    const message = isReviewOnly
      ? "chore(review): approved abc1234 [skip-review]"
      : "feat: real code change";
    return {
      sha,
      commit: { tree: { sha: treeSha }, message },
      parents: [{ sha: "parent-" + sha }],
      files
    };
  };

  it("all GitHub API calls target the specified repository", async () => {
    const requestedUrls = [];

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      requestedUrls.push(typeof url === "string" ? url : url.toString());
      const urlStr = String(url);

      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(
          JSON.stringify({ object: { sha: "a".repeat(40) } }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/commits/")) {
        return new Response(
          JSON.stringify(makeMockCommit("b".repeat(40), "tree-sha-1", false)),
          { status: 200 }
        );
      }
      if (urlStr.includes("/git/blobs")) {
        return new Response(
          JSON.stringify({ sha: "blob-sha-1" }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({ sha: "tree-sha-2" }),
          { status: 201 }
        );
      }
      if (
        urlStr.includes("/git/commits") &&
        !urlStr.includes("/commits/") &&
        !urlStr.includes("/git/ref")
      ) {
        return new Response(
          JSON.stringify({ sha: "c".repeat(40) }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/refs/heads/")) {
        return new Response(
          JSON.stringify({ ref: "refs/heads/dev" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    }));

    await submitReview(
      { GITHUB_TOKEN: "test-token" },
      {
        commit: "b".repeat(40),
        verdict: "approved",
        summary: "Looks good",
        findings: []
      },
      "xinbaijin-mcp"
    );

    const wrongRepoUrls = requestedUrls.filter(
      (url) =>
        url.includes("shunhang776/xinbaijin/") &&
        !url.includes("xinbaijin-mcp")
    );
    expect(wrongRepoUrls).toHaveLength(0);
    expect(requestedUrls.length).toBeGreaterThanOrEqual(5);

    const mcpRepoUrls = requestedUrls.filter((url) =>
      url.includes("shunhang776/xinbaijin-mcp")
    );
    expect(mcpRepoUrls.length).toBe(requestedUrls.length);
  });

  it("stale review is rejected with correct error", async () => {
    const staleCommit = "d".repeat(40);
    const latestCommit = "e".repeat(40);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(
          JSON.stringify({ object: { sha: latestCommit } }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/commits/" + latestCommit)) {
        return new Response(
          JSON.stringify(makeMockCommit(latestCommit, "tree-sha", false)),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    }));

    await expect(
      submitReview(
        { GITHUB_TOKEN: "test-token" },
        {
          commit: staleCommit,
          verdict: "approved",
          summary: "Stale",
          findings: []
        },
        "xinbaijin"
      )
    ).rejects.toThrow(/Stale review rejected/);
  });

  it("concurrent branch update is rejected", async () => {
    let branchHeadCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = String(url);
      const isBranchEndpoint =
        urlStr.includes("/git/ref/heads/") ||
        urlStr.includes("/git/refs/heads/");

      if (isBranchEndpoint) {
        branchHeadCalls++;
        if (branchHeadCalls === 1) {
          return new Response(
            JSON.stringify({ object: { sha: "f".repeat(40) } }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ message: "Reference update failed" }),
          { status: 422 }
        );
      }
      if (urlStr.includes("/commits/")) {
        return new Response(
          JSON.stringify(makeMockCommit("f".repeat(40), "tree-sha", false)),
          { status: 200 }
        );
      }
      if (urlStr.includes("/git/blobs")) {
        return new Response(
          JSON.stringify({ sha: "blob-sha" }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({ sha: "tree-sha" }),
          { status: 201 }
        );
      }
      if (
        urlStr.includes("/git/commits") &&
        !urlStr.includes("/commits/") &&
        !urlStr.includes("/git/ref")
      ) {
        return new Response(
          JSON.stringify({ sha: "g".repeat(40) }),
          { status: 201 }
        );
      }
      return new Response("{}", { status: 200 });
    }));

    await expect(
      submitReview(
        { GITHUB_TOKEN: "test-token" },
        {
          commit: "f".repeat(40),
          verdict: "approved",
          summary: "Concurrent test",
          findings: []
        },
        "xinbaijin"
      )
    ).rejects.toThrow(/Concurrent branch update detected/);
  });
});

// ---------------------------------------------------------------------------
// Group 6: Review-only branch head cross-repo isolation (FIX 2)
// ---------------------------------------------------------------------------

describe("submitReview cross-repo isolation with review-only branch head", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeCodeCommit = (sha, treeSha) => ({
    sha,
    commit: { tree: { sha: treeSha }, message: "feat: real code change" },
    parents: [{ sha: "parent-" + sha }],
    files: [{ filename: "src/index.js" }]
  });

  const makeReviewOnlyCommit = (sha, treeSha, reviewedCommitSha) => ({
    sha,
    commit: {
      tree: { sha: treeSha },
      message:
        "chore(review): approved " +
        reviewedCommitSha.slice(0, 7) +
        " [skip-review]"
    },
    parents: [{ sha: reviewedCommitSha }],
    files: [{ filename: "review.json" }]
  });

  it("all API calls stay in xinbaijin-mcp during review-only head traversal", async () => {
    const codeSha = "a".repeat(40);
    const reviewSha = "b".repeat(40);
    const urls = [];

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      urls.push(urlStr);

      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(
          JSON.stringify({ object: { sha: reviewSha } }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/commits/" + reviewSha)) {
        return new Response(
          JSON.stringify(
            makeReviewOnlyCommit(reviewSha, "review-tree", codeSha)
          ),
          { status: 200 }
        );
      }
      if (urlStr.includes("/contents/review.json")) {
        return new Response(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            content: btoa(
              JSON.stringify({
                reviewed_commit: codeSha,
                verdict: "approved"
              })
            )
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/compare/")) {
        return new Response(
          JSON.stringify({ status: "ahead" }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/commits/" + codeSha)) {
        return new Response(
          JSON.stringify(makeCodeCommit(codeSha, "code-tree")),
          { status: 200 }
        );
      }
      if (urlStr.includes("/git/blobs")) {
        return new Response(
          JSON.stringify({ sha: "blob-sha" }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({ sha: "tree-sha" }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/commits")) {
        return new Response(
          JSON.stringify({ sha: "c".repeat(40) }),
          { status: 201 }
        );
      }
      if (urlStr.includes("/git/refs/heads/")) {
        return new Response(
          JSON.stringify({ ref: "refs/heads/dev" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    }));

    await submitReview(
      { GITHUB_TOKEN: "test" },
      {
        commit: codeSha,
        verdict: "approved",
        summary: "OK",
        findings: []
      },
      "xinbaijin-mcp"
    );

    const wrongRepo = urls.filter(
      (u) =>
        u.includes("shunhang776/") &&
        !u.includes("shunhang776/xinbaijin-mcp")
    );
    expect(wrongRepo).toHaveLength(0);

    const contentsCalls = urls.filter((u) =>
      u.includes("/contents/review.json")
    );
    expect(contentsCalls.length).toBeGreaterThanOrEqual(1);
    contentsCalls.forEach((u) =>
      expect(u).toContain("shunhang776/xinbaijin-mcp")
    );

    const compareCalls = urls.filter((u) => u.includes("/compare/"));
    expect(compareCalls.length).toBeGreaterThanOrEqual(1);
    compareCalls.forEach((u) =>
      expect(u).toContain("shunhang776/xinbaijin-mcp")
    );
  });
});

// ---------------------------------------------------------------------------
// Group 7: Token passthrough
// ---------------------------------------------------------------------------

describe("token handling", () => {
  it("token passes through from env", () => {
    const config = getRepositoryConfig(
      { GITHUB_TOKEN: "ghp_secret123" },
      "xinbaijin"
    );
    expect(config.token).toBe("ghp_secret123");
  });

  it("missing token yields undefined without crash", () => {
    const config = getRepositoryConfig({}, "xinbaijin");
    expect(config.token).toBeUndefined();
  });
});
