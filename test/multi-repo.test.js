import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  REPOSITORIES,
  DEFAULT_REPOSITORY,
  getRepositoryConfig,
  submitReview,
  getLatestReviewableCommit
} from "../review-core.js";

// ---------------------------------------------------------------------------
// Group 1: getRepositoryConfig validation
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
    // repositoryName || DEFAULT_REPOSITORY — empty string is falsy
    const config = getRepositoryConfig(mockEnv, "");
    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin");
    expect(config.branch).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// Group 2: REPOSITORIES whitelist structure
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
// Group 3: Cross-repo isolation (string level)
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
// Group 4: Cross-repo isolation with mocked fetch (end-to-end)
// ---------------------------------------------------------------------------

describe("submitReview uses single repository for entire call chain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const makeMockCommit = (sha, treeSha, isReviewOnly = false) => ({
    sha,
    commit: {
      tree: { sha: treeSha },
      message: isReviewOnly
        ? "chore(review): approved abc1234 [skip-review]"
        : "feat: real code change"
    },
    parents: [{ sha: "parent-" + sha }],
    files: isReviewOnly
      ? [{ filename: "review.json" }]
      : [{ filename: "src/index.js" }]
  });

  it("all GitHub API calls target the specified repository", async () => {
    const requestedUrls = [];

    global.fetch = vi.fn(async (url, options) => {
      requestedUrls.push(typeof url === "string" ? url : url.toString());
      const urlStr = String(url);

      // Branch head
      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(
          JSON.stringify({ object: { sha: "a".repeat(40) } }),
          { status: 200 }
        );
      }
      // Commit details
      if (urlStr.includes("/commits/")) {
        return new Response(
          JSON.stringify(makeMockCommit("b".repeat(40), "tree-sha-1")),
          { status: 200 }
        );
      }
      // Create blob
      if (urlStr.includes("/git/blobs")) {
        return new Response(
          JSON.stringify({ sha: "blob-sha-1" }),
          { status: 201 }
        );
      }
      // Create tree
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({ sha: "tree-sha-2" }),
          { status: 201 }
        );
      }
      // Create commit (POST /git/commits, not GET /commits/:sha or /git/ref)
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
      // Update ref
      if (urlStr.includes("/git/refs/heads/")) {
        return new Response(
          JSON.stringify({ ref: "refs/heads/dev" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });

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

    // Every URL must contain xinbaijin-mcp, NOT xinbaijin
    const wrongRepoUrls = requestedUrls.filter(
      (url) =>
        url.includes("shunhang776/xinbaijin/") &&
        !url.includes("xinbaijin-mcp")
    );
    expect(wrongRepoUrls).toHaveLength(0);

    // At least 5 calls were made (branch head, commit details, blob, tree, commit, ref update)
    expect(requestedUrls.length).toBeGreaterThanOrEqual(5);

    // All URLs must include the correct repo path
    const mcpRepoUrls = requestedUrls.filter((url) =>
      url.includes("shunhang776/xinbaijin-mcp")
    );
    expect(mcpRepoUrls.length).toBe(requestedUrls.length);
  });

  it("stale review is rejected with correct error", async () => {
    const staleCommit = "d".repeat(40);
    const latestCommit = "e".repeat(40);

    global.fetch = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(
          JSON.stringify({ object: { sha: latestCommit } }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/commits/" + latestCommit)) {
        return new Response(
          JSON.stringify(makeMockCommit(latestCommit, "tree-sha")),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });

    await expect(
      submitReview(
        { GITHUB_TOKEN: "test-token" },
        {
          commit: staleCommit, // different from latestCommit
          verdict: "approved",
          summary: "Stale",
          findings: []
        },
        "xinbaijin"
      )
    ).rejects.toThrow(/Stale review rejected/);
  });

  it("concurrent branch update is rejected", async () => {
    // getBranchHeadSha uses /git/ref/heads/ (no "s")
    // updateBranchRefFastForward uses /git/refs/heads/ (with "s")
    // The mock must handle both URL patterns.
    let branchHeadCalls = 0;

    global.fetch = vi.fn(async (url, options) => {
      const urlStr = String(url);

      const isBranchEndpoint =
        urlStr.includes("/git/ref/heads/") ||
        urlStr.includes("/git/refs/heads/");

      if (isBranchEndpoint) {
        branchHeadCalls++;
        if (branchHeadCalls === 1) {
          // First call: getBranchHeadSha reads the current head
          return new Response(
            JSON.stringify({ object: { sha: "f".repeat(40) } }),
            { status: 200 }
          );
        }
        // Second call: updateBranchRefFastForward patches the ref —
        // simulate a concurrent update that changed the branch head.
        return new Response(
          JSON.stringify({ message: "Reference update failed" }),
          { status: 422 }
        );
      }
      if (urlStr.includes("/commits/")) {
        return new Response(
          JSON.stringify(makeMockCommit("f".repeat(40), "tree-sha")),
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
    });

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
// Group 5: Token passthrough
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
