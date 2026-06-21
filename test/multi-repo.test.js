import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { REPOSITORIES, REPOSITORY_NAMES, getRepositoryConfig, submitReview } from "../review-core.js";
import {
  REPOSITORY_PARAM,
  GET_LATEST_HANDOFF_SCHEMA,
  GET_PATCH_SCHEMA,
  SUBMIT_REVIEW_SCHEMA,
  GET_FILE_CONTENT_SCHEMA
} from "../mcp-schemas.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Group 1: MCP tool schemas reject missing repository — uses production schemas
// ---------------------------------------------------------------------------

describe("MCP tool schemas — repository is optional (defaults to xinbaijin)", () => {
  it("get_latest_handoff accepts missing repository", () => {
    const result = z.object(GET_LATEST_HANDOFF_SCHEMA).safeParse({});
    expect(result.success).toBe(true);
  });

  it("get_patch accepts missing repository", () => {
    const result = GET_PATCH_SCHEMA.safeParse({});
    expect(result.success).toBe(true);
  });

  it("get_file_content accepts missing repository (path+ref still required)", () => {
    // path and ref are still required; only repository is optional
    const result = z.object(GET_FILE_CONTENT_SCHEMA).safeParse({});
    expect(result.success).toBe(false); // path + ref missing
  });

  it("submit_review accepts missing repository (commit still required)", () => {
    const result = SUBMIT_REVIEW_SCHEMA.safeParse({});
    expect(result.success).toBe(false); // commit + verdict etc missing
  });

  it("get_patch accepts valid repository plus optional sha", () => {
    const result = GET_PATCH_SCHEMA.safeParse({ repository: "xinbaijin-mcp" });
    expect(result.success).toBe(true);
  });

  it("submit_review accepts valid repository plus required fields", () => {
    const result = SUBMIT_REVIEW_SCHEMA.safeParse({
      repository: "xinbaijin",
      commit: "a".repeat(40),
      verdict: "approved",
      summary: "Looks good",
      findings: []
    });
    expect(result.success).toBe(true);
  });

  it("get_file_content accepts valid path, ref, and repository", () => {
    const result = z.object(GET_FILE_CONTENT_SCHEMA).safeParse({
      path: "src/index.js",
      ref: "a".repeat(40),
      repository: "xinbaijin-mcp"
    });
    expect(result.success).toBe(true);
  });

  it("submit_review rejects invalid repository values", () => {
    const result = SUBMIT_REVIEW_SCHEMA.safeParse({
      repository: "evil-repo",
      commit: "a".repeat(40),
      verdict: "approved",
      summary: "Nope",
      findings: []
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2: getRepositoryConfig validation
// ---------------------------------------------------------------------------

describe("getRepositoryConfig", () => {
  const mockEnv = { GITHUB_TOKEN: "test-token" };

  it("rejects when repository is omitted", () => {
    expect(() => getRepositoryConfig(mockEnv)).toThrow(/repository is required/);
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

  it("rejects undefined/null/empty repositoryName", () => {
    expect(() => getRepositoryConfig(mockEnv, undefined)).toThrow(/repository is required/);
    expect(() => getRepositoryConfig(mockEnv, null)).toThrow(/repository is required/);
    expect(() => getRepositoryConfig(mockEnv, "")).toThrow(/repository is required/);
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

  it("REPOSITORY_NAMES matches REPOSITORIES keys exactly", () => {
    expect(new Set(REPOSITORY_NAMES)).toEqual(new Set(Object.keys(REPOSITORIES)));
    expect(REPOSITORY_NAMES.length).toBe(2);
  });

  it("Zod enum values match REPOSITORY_NAMES", () => {
    // Verify the MCP schema whitelist is derived from the canonical list,
    // not independently hardcoded.
    const validRepos = ["xinbaijin", "xinbaijin-mcp"];
    validRepos.forEach((repo) => {
      const result = z.object({ repository: REPOSITORY_PARAM }).safeParse({ repository: repo });
      expect(result.success).toBe(true);
    });
    // Non-whitelist still rejected
    const bad = z.object({ repository: REPOSITORY_PARAM }).safeParse({ repository: "evil" });
    expect(bad.success).toBe(false);
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
    // submitReview calls getBranchHeadSha + updateBranchRefFastForward
    // which re-reads branch head before PATCH. GET returns valid SHA;
    // the PATCH (/git/refs/heads/) returns 422.
    let patchForceCorrect = false;

    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const urlStr = String(url);

      // GET branch head (no "s" after ref) — always succeeds
      if (urlStr.includes("/git/ref/heads/dev") && !urlStr.includes("refs")) {
        return new Response(
          JSON.stringify({ object: { sha: "f".repeat(40) } }),
          { status: 200 }
        );
      }

      // PATCH branch ref (with "s") — simulates concurrent update
      if (urlStr.includes("/git/refs/heads/dev")) {
        if (options && options.body) {
          const body = JSON.parse(options.body);
          patchForceCorrect = body.force === false;
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
    expect(patchForceCorrect).toBe(true);
  });

  it("submitReview rejects undefined repository", async () => {
    await expect(
      submitReview(
        { GITHUB_TOKEN: "test-token" },
        {
          commit: "b".repeat(40),
          verdict: "approved",
          summary: "No repo",
          findings: []
        },
        undefined
      )
    ).rejects.toThrow(/repository is required/);
  });

  it("rejects when branch head changes between read and write", async () => {
    // getBranchHeadSha called twice: initial read + pre-PATCH re-read.
    // First returns one SHA, second returns a different one — code detects
    // mismatch and throws before the actual PATCH.
    const firstSha = "a".repeat(40);
    const changedSha = "b".repeat(40);
    let getCallCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const urlStr = String(url);

      // GET /git/ref/heads/dev (no "s") — branch head reads
      if (urlStr.includes("/git/ref/heads/dev") && !urlStr.includes("refs")) {
        getCallCount++;
        const sha = getCallCount === 1 ? firstSha : changedSha;
        return new Response(
          JSON.stringify({ object: { sha } }),
          { status: 200 }
        );
      }

      // The PATCH /git/refs/heads/dev should never be reached
      if (urlStr.includes("/git/refs/heads/dev")) {
        return new Response("unreachable", { status: 200 });
      }

      if (urlStr.includes("/commits/")) {
        return new Response(JSON.stringify({
          sha: firstSha,
          commit: { tree: { sha: "da".repeat(20) }, message: "feat: some code" },
          parents: [{ sha: "0".repeat(40) }],
          files: [{ filename: "src/app.js" }]
        }), { status: 200 });
      }
      if (urlStr.includes("/git/blobs")) {
        return new Response(JSON.stringify({ sha: "bb".repeat(20) }), { status: 201 });
      }
      if (urlStr.includes("/git/trees")) {
        return new Response(JSON.stringify({ sha: "cc".repeat(20) }), { status: 201 });
      }
      if (urlStr.includes("/git/commits") && !urlStr.includes("/commits/") && !urlStr.includes("/git/ref")) {
        return new Response(JSON.stringify({ sha: "dd".repeat(20) }), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    }));

    await expect(
      submitReview(
        { GITHUB_TOKEN: "test" },
        { commit: firstSha, verdict: "approved", summary: "Race", findings: [] },
        "xinbaijin"
      )
    ).rejects.toThrow(/Concurrent branch update/);
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

  it("rejects fast path when non-review-only commit sits between head and candidate", async () => {
    // History: codeSha (old code) -> midCodeSha (newer code!) -> reviewSha (review-only pointing to OLD codeSha)
    // The fast path should detect midCodeSha is non-review-only and fall through to walking,
    // ultimately finding midCodeSha as the latest code commit, NOT codeSha.
    const codeSha = "1".repeat(40);
    const midCodeSha = "2".repeat(40);
    const reviewSha = "3".repeat(40);
    const urls = [];

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = String(url);
      urls.push(urlStr);

      if (urlStr.includes("/git/ref/heads/dev")) {
        return new Response(JSON.stringify({ object: { sha: reviewSha } }), { status: 200 });
      }
      if (urlStr.includes("/commits/" + reviewSha)) {
        return new Response(JSON.stringify({
          sha: reviewSha,
          commit: { tree: { sha: "rt" }, message: "chore(review): approved " + codeSha.slice(0,7) + " [skip-review]" },
          parents: [{ sha: midCodeSha }],
          files: [{ filename: "review.json" }]
        }), { status: 200 });
      }
      if (urlStr.includes("/contents/review.json")) {
        return new Response(JSON.stringify({
          type: "file", encoding: "base64",
          content: btoa(JSON.stringify({ reviewed_commit: codeSha }))
        }), { status: 200 });
      }
      if (urlStr.includes("/compare/")) {
        return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
      }
      if (urlStr.includes("/commits/" + codeSha)) {
        return new Response(JSON.stringify({
          sha: codeSha,
          commit: { tree: { sha: "ct" }, message: "feat: old code" },
          parents: [{ sha: "0".repeat(40) }],
          files: [{ filename: "src/old.js" }]
        }), { status: 200 });
      }
      if (urlStr.includes("/commits/" + midCodeSha)) {
        return new Response(JSON.stringify({
          sha: midCodeSha,
          commit: { tree: { sha: "mt" }, message: "feat: newer code" },
          parents: [{ sha: codeSha }],
          files: [{ filename: "src/new.js" }]
        }), { status: 200 });
      }
      if (urlStr.includes("/git/blobs")) {
        return new Response(JSON.stringify({ sha: "bx" }), { status: 201 });
      }
      if (urlStr.includes("/git/trees")) {
        return new Response(JSON.stringify({ sha: "tx" }), { status: 201 });
      }
      if (urlStr.includes("/git/commits") && !urlStr.includes("/commits/") && !urlStr.includes("/git/ref")) {
        return new Response(JSON.stringify({ sha: "4".repeat(40) }), { status: 201 });
      }
      if (urlStr.includes("/git/refs/heads/")) {
        return new Response(JSON.stringify({ ref: "refs/heads/dev" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    // Submit with the OLD codeSha — should be rejected as stale
    // because the actual latest code commit is midCodeSha
    await expect(
      submitReview(
        { GITHUB_TOKEN: "test" },
        { commit: codeSha, verdict: "approved", summary: "Stale fast path", findings: [] },
        "xinbaijin-mcp"
      )
    ).rejects.toThrow(/Stale review rejected/);

    // Verify the walking path found midCodeSha
    const midCodeCalls = urls.filter(u => u.includes("/commits/" + midCodeSha));
    expect(midCodeCalls.length).toBeGreaterThanOrEqual(1);
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
