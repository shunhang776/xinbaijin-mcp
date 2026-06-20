import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  getRepositoryConfig,
  getLatestReviewableCommit,
  submitReview
} from "../review-core.js";

const ENV = {
  GITHUB_TOKEN: "test-token"
};

// ── helpers ──

function json(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

function sha(number) {
  return number
    .toString(16)
    .padStart(40, "0");
}

function reviewCommit(commitSha, parentSha) {
  return {
    sha: commitSha,
    files: [
      {
        filename: "review.json",
        status: "modified"
      }
    ],
    parents: parentSha
      ? [{ sha: parentSha }]
      : []
  };
}

function codeCommit(commitSha) {
  return {
    sha: commitSha,
    commit: {
      tree: {
        sha: "c".repeat(40)
      }
    },
    files: [
      {
        filename: "worker.js",
        status: "modified"
      }
    ],
    parents: []
  };
}

function getUrl(input) {
  return new URL(
    typeof input === "string"
      ? input
      : input.url
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── tests ──

describe("getRepositoryConfig", () => {
  it("defaults to xinbaijin when repository is omitted", () => {
    const config = getRepositoryConfig(ENV);

    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin");
    expect(config.branch).toBe("dev");
    expect(config.token).toBe("test-token");
  });

  it("explicitly resolves xinbaijin-mcp correctly", () => {
    const config = getRepositoryConfig(ENV, "xinbaijin-mcp");

    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin-mcp");
    expect(config.branch).toBe("dev");
    expect(config.token).toBe("test-token");
  });

  it("throws for a non-whitelist repository", () => {
    expect(() =>
      getRepositoryConfig(ENV, "evil-repo")
    ).toThrow(/Unknown repository/);
  });

  it("explicitly resolves xinbaijin correctly", () => {
    const config = getRepositoryConfig(ENV, "xinbaijin");

    expect(config.owner).toBe("shunhang776");
    expect(config.repo).toBe("xinbaijin");
    expect(config.branch).toBe("dev");
  });
});

describe("tool consistency across repositories", () => {
  it("getLatestReviewableCommit uses the specified repository", async () => {
    const codeSha = sha(1);

    const fetchMock = vi.fn(async (input, init = {}) => {
      const { pathname } = getUrl(input);
      const method = String(init.method || "GET").toUpperCase();

      if (
        method === "GET" &&
        pathname.endsWith(`/commits/${codeSha}`)
      ) {
        return json(codeCommit(codeSha));
      }

      return json({ message: "Not Found" }, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await getLatestReviewableCommit(
      ENV,
      codeSha,
      "xinbaijin-mcp"
    );

    expect(result.sha).toBe(codeSha);

    // 验证所有 API 调用都指向 xinbaijin-mcp
    const calls = fetchMock.mock.calls;

    expect(calls.length).toBeGreaterThan(0);

    calls.forEach(([input]) => {
      const url = getUrl(input);

      expect(url.pathname).toMatch(
        /^\/repos\/shunhang776\/xinbaijin-mcp\//
      );
    });
  });

  it("submitReview uses a single repository for every Git API call", async () => {
    const codeSha = "a".repeat(40);
    const baseTreeSha = "c".repeat(40);

    const urls = [];

    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = getUrl(input);

      urls.push(url.pathname);

      const { pathname } = url;
      const method = String(init.method || "GET").toUpperCase();

      if (
        method === "GET" &&
        pathname.endsWith("/git/ref/heads/dev")
      ) {
        return json({ object: { sha: codeSha } });
      }

      if (
        method === "GET" &&
        pathname.includes("/commits/")
      ) {
        return json(codeCommit(codeSha));
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/blobs")
      ) {
        return json({ sha: "d".repeat(40) });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/trees")
      ) {
        return json({ sha: "e".repeat(40) });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/commits")
      ) {
        return json({ sha: "f".repeat(40) });
      }

      if (
        method === "PATCH" &&
        pathname.endsWith("/git/refs/heads/dev")
      ) {
        return json({
          ref: "refs/heads/dev",
          object: { sha: "f".repeat(40) }
        });
      }

      return json({ message: "Unhandled" }, 500);
    });

    vi.stubGlobal("fetch", fetchMock);

    await submitReview(
      ENV,
      {
        commit: codeSha,
        verdict: "approved",
        summary: "looks good",
        findings: []
      },
      "xinbaijin-mcp"
    );

    // 每一个 API 调用都必须指向 xinbaijin-mcp
    expect(urls.length).toBeGreaterThan(0);

    urls.forEach((pathname) => {
      expect(pathname).toMatch(
        /^\/repos\/shunhang776\/xinbaijin-mcp\//
      );
    });
  });
});

describe("existing protections with default repository", () => {
  it("rejects a stale review against the default xinbaijin repository", async () => {
    const codeSha = "a".repeat(40);

    const fetchMock = vi.fn(async (input, init = {}) => {
      const { pathname } = getUrl(input);
      const method = String(init.method || "GET").toUpperCase();

      if (
        method === "GET" &&
        pathname.endsWith("/git/ref/heads/dev")
      ) {
        return json({ object: { sha: codeSha } });
      }

      if (
        method === "GET" &&
        pathname.includes("/commits/")
      ) {
        return json(codeCommit(sha(99)));
      }

      return json({ message: "Unhandled" }, 500);
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitReview(
        ENV,
        {
          commit: codeSha,
          verdict: "approved",
          summary: "stale",
          findings: []
        }
      )
    ).rejects.toThrow(/Stale review rejected/);
  });
});
