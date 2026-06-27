import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  submitReview
} from "../review-core.js";

const CODE_SHA = "a".repeat(40);
const BRANCH_HEAD = CODE_SHA;
const BASE_TREE_SHA = "c".repeat(40);
const REVIEW_SHA = "1".repeat(40);

const ENV = {
  GITHUB_TOKEN: "test-token"
};

function reviewInput(summary) {
  return {
    commit: CODE_SHA,
    verdict: "approved",
    summary,
    findings: []
  };
}

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

function getUrl(input) {
  return new URL(
    typeof input === "string"
      ? input
      : input.url
  );
}

function bodyOf(init) {
  return init?.body
    ? JSON.parse(init.body)
    : {};
}

function prWritebackMock() {
  const observedEndpoints = {
    devRefPatch: [],
    refCreate: [],
    reviewRefPatch: [],
    prCreate: []
  };

  const fetchMock = vi.fn(
    async (input, init = {}) => {
      const { pathname } = getUrl(input);
      const method = String(
        init.method || "GET"
      ).toUpperCase();

      // GET dev branch head
      if (
        method === "GET" &&
        pathname.endsWith("/git/ref/heads/dev")
      ) {
        return json({
          object: {
            sha: BRANCH_HEAD
          }
        });
      }

      // GET commit details
      if (
        method === "GET" &&
        pathname.includes("/commits/")
      ) {
        return json({
          sha: CODE_SHA,
          commit: {
            tree: {
              sha: BASE_TREE_SHA
            }
          },
          files: [
            {
              filename: "worker.js",
              status: "modified"
            }
          ],
          parents: []
        });
      }

      // POST create blob
      if (
        method === "POST" &&
        pathname.endsWith("/git/blobs")
      ) {
        return json(
          { sha: "d".repeat(40) },
          201
        );
      }

      // POST create tree
      if (
        method === "POST" &&
        pathname.endsWith("/git/trees")
      ) {
        return json(
          { sha: "e".repeat(40) },
          201
        );
      }

      // POST create commit
      if (
        method === "POST" &&
        pathname.endsWith("/git/commits")
      ) {
        return json(
          { sha: REVIEW_SHA },
          201
        );
      }

      // POST create branch ref
      if (
        method === "POST" &&
        pathname.endsWith("/git/refs")
      ) {
        const body = bodyOf(init);

        observedEndpoints.refCreate.push(body);

        return json(
          {
            ref: body.ref,
            object: {
              sha: body.sha
            }
          },
          201
        );
      }

      // PATCH update review branch (not dev)
      if (
        method === "PATCH" &&
        pathname.includes(
          "/git/refs/heads/review/"
        )
      ) {
        const body = bodyOf(init);

        observedEndpoints.reviewRefPatch.push({
          pathname,
          body
        });

        return json({
          ref: pathname
            .split("/git/")[1]
            .replace("refs/", "refs/"),
          object: {
            sha: body.sha
          }
        });
      }

      // Track PATCH to dev ref (should never happen)
      if (
        method === "PATCH" &&
        pathname.endsWith("/git/refs/heads/dev")
      ) {
        observedEndpoints.devRefPatch.push({
          pathname,
          body: bodyOf(init)
        });

        return json(
          {
            ref: "refs/heads/dev",
            object: {
              sha: bodyOf(init).sha
            }
          },
          200
        );
      }

      // POST create PR
      if (
        method === "POST" &&
        pathname.endsWith("/pulls")
      ) {
        const body = bodyOf(init);

        observedEndpoints.prCreate.push(body);

        return json(
          {
            html_url:
              "https://github.com/shunhang776/xinbaijin-mcp/pull/42",
            number: 42
          },
          201
        );
      }

      return json(
        {
          message:
            `Unhandled ${method} ${pathname}`
        },
        500
      );
    }
  );

  return {
    fetchMock,
    observedEndpoints
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(
  "submitReview PR-based writeback",
  () => {

    it(
      "does NOT PATCH the dev branch ref",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        await submitReview(
          ENV,
          reviewInput("No dev PATCH test"),
          "xinbaijin-mcp"
        );

        expect(
          mock.observedEndpoints.devRefPatch
        ).toHaveLength(0);
      }
    );

    it(
      "creates a review branch with correct name format",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        await submitReview(
          ENV,
          reviewInput("Branch name test"),
          "xinbaijin-mcp"
        );

        expect(
          mock.observedEndpoints.refCreate
        ).toHaveLength(1);

        const branchRef =
          mock.observedEndpoints.refCreate[0];

        // ref must be "refs/heads/review/{repo}/{shortSha}-{timestamp}-{nonce}"
        expect(branchRef.ref).toMatch(
          /^refs\/heads\/review\/xinbaijin-mcp\/aaaaaaa-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/
        );

        // initial sha must be the pinned branchHead
        expect(branchRef.sha).toBe(
          BRANCH_HEAD
        );
      }
    );

    it(
      "writes review.json to the review branch (PATCHes the review ref)",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        const result = await submitReview(
          ENV,
          reviewInput(
            "Review branch write test"
          ),
          "xinbaijin-mcp"
        );

        // review branch was created
        expect(
          mock.observedEndpoints.refCreate
        ).toHaveLength(1);

        // review branch was updated to the review commit
        expect(
          mock.observedEndpoints.reviewRefPatch
        ).toHaveLength(1);

        expect(
          mock.observedEndpoints.reviewRefPatch[0]
            .body.sha
        ).toBe(REVIEW_SHA);

        expect(
          mock.observedEndpoints.reviewRefPatch[0]
            .body.force
        ).toBe(false);

        expect(result.review_commit).toBe(
          REVIEW_SHA
        );
      }
    );

    it(
      "creates a PR with base=dev and head=review branch",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        const result = await submitReview(
          ENV,
          reviewInput("PR base test"),
          "xinbaijin-mcp"
        );

        expect(
          mock.observedEndpoints.prCreate
        ).toHaveLength(1);

        const prBody =
          mock.observedEndpoints.prCreate[0];

        expect(prBody.base).toBe("dev");
        expect(prBody.head).toMatch(
          /^review\/xinbaijin-mcp\/aaaaaaa-/
        );
        expect(prBody.title).toMatch(
          /^chore\(review\): approved aaaaaaa$/
        );

        // PR body contains review metadata
        expect(prBody.body).toContain(
          "shunhang776/xinbaijin-mcp"
        );
        expect(prBody.body).toContain(
          CODE_SHA
        );
        expect(prBody.body).toContain(
          "approved"
        );

        // result contains PR URL and number
        expect(
          result.pull_request_url
        ).toContain("/pull/42");
        expect(
          result.pull_request_number
        ).toBe(42);
      }
    );

    it(
      "rejects a stale review (input.commit !== latest code commit)",
      async () => {
        const STALE_SHA = "b".repeat(40);
        const REAL_CODE_SHA = "c".repeat(40);

        const fetchMock = vi.fn(
          async (input) => {
            const { pathname } = getUrl(
              input
            );

            if (
              pathname.endsWith(
                "/git/ref/heads/dev"
              )
            ) {
              return json({
                object: {
                  sha: REAL_CODE_SHA
                }
              });
            }

            if (
              pathname.includes(
                `/commits/${REAL_CODE_SHA}`
              )
            ) {
              return json({
                sha: REAL_CODE_SHA,
                commit: {
                  tree: {
                    sha: BASE_TREE_SHA
                  }
                },
                files: [
                  {
                    filename: "src/app.js",
                    status: "modified"
                  }
                ],
                parents: []
              });
            }

            return json(
              {
                message: "Not Found"
              },
              404
            );
          }
        );

        vi.stubGlobal(
          "fetch",
          fetchMock
        );

        await expect(
          submitReview(
            ENV,
            {
              commit: STALE_SHA,
              verdict: "approved",
              summary: "Stale",
              findings: []
            },
            "xinbaijin"
          )
        ).rejects.toThrow(
          /Stale review rejected/
        );
      }
    );

    it(
      "rejects when branch head changes between read and review branch creation",
      async () => {
        const INITIAL_HEAD =
          "a".repeat(40);
        const CHANGED_HEAD =
          "b".repeat(40);
        let headReadCount = 0;

        const fetchMock = vi.fn(
          async (input, init = {}) => {
            const { pathname } = getUrl(
              input
            );
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            // GET dev head: first call returns INITIAL,
            // subsequent calls return CHANGED
            if (
              method === "GET" &&
              pathname.endsWith(
                "/git/ref/heads/dev"
              )
            ) {
              headReadCount++;

              const sha =
                headReadCount >= 2
                  ? CHANGED_HEAD
                  : INITIAL_HEAD;

              return json({
                object: { sha }
              });
            }

            // GET commit details
            if (
              method === "GET" &&
              pathname.includes(
                "/commits/"
              )
            ) {
              return json({
                sha: INITIAL_HEAD,
                commit: {
                  tree: {
                    sha: BASE_TREE_SHA
                  }
                },
                files: [
                  {
                    filename:
                      "worker.js",
                    status: "modified"
                  }
                ],
                parents: []
              });
            }

            // POST blob
            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/blobs"
              )
            ) {
              return json(
                {
                  sha: "d".repeat(40)
                },
                201
              );
            }

            // POST tree
            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/trees"
              )
            ) {
              return json(
                {
                  sha: "e".repeat(40)
                },
                201
              );
            }

            // POST create commit
            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/commits"
              )
            ) {
              return json(
                { sha: REVIEW_SHA },
                201
              );
            }

            // These should not be reached because
            // concurrent check fires first
            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/refs"
              )
            ) {
              return json(
                { ref: "ok" },
                201
              );
            }

            if (
              method === "PATCH" &&
              pathname.includes(
                "/git/refs/heads/review/"
              )
            ) {
              return json(
                { ref: "ok" },
                200
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith("/pulls")
            ) {
              return json(
                {
                  html_url:
                    "https://example.com/pr/1",
                  number: 1
                },
                201
              );
            }

            return json(
              {
                message:
                  `Unhandled ${method} ${pathname}`
              },
              500
            );
          }
        );

        vi.stubGlobal(
          "fetch",
          fetchMock
        );

        await expect(
          submitReview(
            ENV,
            {
              commit: INITIAL_HEAD,
              verdict: "approved",
              summary:
                "Concurrent",
              findings: []
            },
            "xinbaijin"
          )
        ).rejects.toThrow(
          /Concurrent branch update detected/
        );

        // head was read at least twice
        // (initial + re-read before review branch)
        expect(
          headReadCount
        ).toBeGreaterThanOrEqual(2);
      }
    );

    it(
      "populates PR body with all required metadata fields",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        await submitReview(
          ENV,
          {
            commit: CODE_SHA,
            verdict: "changes_requested",
            summary:
              "Found some issues in error handling.",
            findings: [
              {
                severity: "high",
                file: "worker.js",
                line: 42,
                title:
                  "Missing error boundary",
                description:
                  "The try/catch does not cover...",
                recommendation:
                  "Add a catch clause for..."
              },
              {
                severity: "medium",
                file: "review-core.js",
                line: null,
                title:
                  "Inconsistent naming",
                description:
                  "Variable naming does not follow convention.",
                recommendation:
                  "Rename to match project style."
              }
            ]
          },
          "xinbaijin-mcp"
        );

        const prBody =
          mock.observedEndpoints.prCreate[0];

        expect(prBody.body).toContain(
          "shunhang776/xinbaijin-mcp"
        );
        expect(prBody.body).toContain(
          CODE_SHA
        );
        expect(prBody.body).toContain(
          BRANCH_HEAD
        );
        expect(prBody.body).toContain(
          "changes_requested"
        );
        expect(prBody.body).toContain(
          "- **Findings**: 2"
        );
        expect(prBody.body).toContain(
          "Found some issues in error handling."
        );

        expect(prBody.title).toBe(
          `chore(review): changes_requested ${CODE_SHA.slice(0, 7)}`
        );
      }
    );

    it(
      "returns all expected fields including writeback_mode",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        const result = await submitReview(
          ENV,
          reviewInput(
            "Return value test"
          ),
          "xinbaijin-mcp"
        );

        expect(result.ok).toBe(true);
        expect(result.protocol).toBe(
          "xinbaijin-review/1.0"
        );
        expect(result.repository).toBe(
          "shunhang776/xinbaijin-mcp"
        );
        expect(result.branch).toBe("dev");
        expect(result.path).toBe(
          "review.json"
        );
        expect(
          result.reviewed_commit
        ).toBe(CODE_SHA);
        expect(
          result.based_on_branch_head
        ).toBe(BRANCH_HEAD);
        expect(result.verdict).toBe(
          "approved"
        );
        expect(result.review_commit).toBe(
          REVIEW_SHA
        );
        expect(result.file_sha).toBe(
          "d".repeat(40)
        );
        expect(
          result.review_branch
        ).toMatch(
          /^review\/xinbaijin-mcp\/aaaaaaa-/
        );
        expect(
          result.pull_request_url
        ).toBe(
          "https://github.com/shunhang776/xinbaijin-mcp/pull/42"
        );
        expect(
          result.pull_request_number
        ).toBe(42);
        expect(
          result.writeback_mode
        ).toBe("pr");
        expect(
          result.message
        ).toContain("pull request");
      }
    );

    it(
      "passes repositoryName explicitly (cross-repo isolation)",
      async () => {
        // Verify that xinbaijin and xinbaijin-mcp
        // each go to the correct repo.
        const xinbaijinUrls = [];
        const xinbaijinMcpUrls = [];

        const fetchMock = vi.fn(
          async (
            input,
            init = {}
          ) => {
            const url = getUrl(input);
            const { pathname } = url;
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            const urlStr = url.toString();

            // Track which repo each call targets
            if (
              urlStr.includes(
                "shunhang776/xinbaijin/"
              ) &&
              !urlStr.includes(
                "xinbaijin-mcp"
              )
            ) {
              xinbaijinUrls.push({
                method,
                pathname
              });
            } else if (
              urlStr.includes(
                "xinbaijin-mcp"
              )
            ) {
              xinbaijinMcpUrls.push({
                method,
                pathname
              });
            }

            if (
              method === "GET" &&
              pathname.endsWith(
                "/git/ref/heads/dev"
              )
            ) {
              return json({
                object: {
                  sha: BRANCH_HEAD
                }
              });
            }

            if (
              method === "GET" &&
              pathname.includes(
                "/commits/"
              )
            ) {
              return json({
                sha: CODE_SHA,
                commit: {
                  tree: {
                    sha: BASE_TREE_SHA
                  }
                },
                files: [
                  {
                    filename:
                      "worker.js",
                    status: "modified"
                  }
                ],
                parents: []
              });
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/blobs"
              )
            ) {
              return json(
                {
                  sha: "d".repeat(40)
                },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/trees"
              )
            ) {
              return json(
                {
                  sha: "e".repeat(40)
                },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/commits"
              )
            ) {
              return json(
                { sha: REVIEW_SHA },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/refs"
              )
            ) {
              const body =
                bodyOf(init);

              return json(
                {
                  ref: body.ref,
                  object: {
                    sha: body.sha
                  }
                },
                201
              );
            }

            if (
              method === "PATCH" &&
              pathname.includes(
                "/git/refs/heads/review/"
              )
            ) {
              return json(
                {
                  ref: "ok",
                  object: {
                    sha:
                      bodyOf(
                        init
                      ).sha
                  }
                },
                200
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/pulls"
              )
            ) {
              return json(
                {
                  html_url:
                    "https://github.com/example/pr/1",
                  number: 1
                },
                201
              );
            }

            return json(
              {
                message:
                  "Unhandled"
              },
              500
            );
          }
        );

        vi.stubGlobal(
          "fetch",
          fetchMock
        );

        await submitReview(
          ENV,
          reviewInput(
            "xinbaijin test"
          ),
          "xinbaijin"
        );

        await submitReview(
          ENV,
          reviewInput(
            "xinbaijin-mcp test"
          ),
          "xinbaijin-mcp"
        );

        // xinbaijin calls target xinbaijin repo
        expect(
          xinbaijinUrls.length
        ).toBeGreaterThan(0);

        const wrongXinbaijinUrl =
          xinbaijinUrls.filter(
            (call) =>
              call.pathname.includes(
                "xinbaijin-mcp"
              )
          );

        expect(
          wrongXinbaijinUrl
        ).toHaveLength(0);

        // xinbaijin-mcp calls target xinbaijin-mcp repo
        expect(
          xinbaijinMcpUrls.length
        ).toBeGreaterThan(0);

        const wrongMcpUrl =
          xinbaijinMcpUrls.filter(
            (call) =>
              !call.pathname.includes(
                "xinbaijin-mcp"
              )
          );

        expect(
          wrongMcpUrl
        ).toHaveLength(0);
      }
    );

    it(
      "returns helpful error when PR creation gets 403 (missing Pull requests scope)",
      async () => {
        const fetchMock = vi.fn(
          async (input, init = {}) => {
            const { pathname } = getUrl(input);
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            if (
              method === "GET" &&
              pathname.endsWith(
                "/git/ref/heads/dev"
              )
            ) {
              return json({
                object: {
                  sha: BRANCH_HEAD
                }
              });
            }

            if (
              method === "GET" &&
              pathname.includes("/commits/")
            ) {
              return json({
                sha: CODE_SHA,
                commit: {
                  tree: {
                    sha: BASE_TREE_SHA
                  }
                },
                files: [
                  {
                    filename:
                      "worker.js",
                    status: "modified"
                  }
                ],
                parents: []
              });
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/blobs"
              )
            ) {
              return json(
                { sha: "d".repeat(40) },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/trees"
              )
            ) {
              return json(
                { sha: "e".repeat(40) },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/commits"
              )
            ) {
              return json(
                { sha: REVIEW_SHA },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/refs"
              )
            ) {
              return json(
                {
                  ref: bodyOf(init)
                    .ref,
                  object: {
                    sha: bodyOf(init)
                      .sha
                  }
                },
                201
              );
            }

            if (
              method === "PATCH" &&
              pathname.includes(
                "/git/refs/heads/review/"
              )
            ) {
              return json(
                { ref: "ok" },
                200
              );
            }

            // PR creation returns 403
            if (
              method === "POST" &&
              pathname.endsWith(
                "/pulls"
              )
            ) {
              return json(
                {
                  message:
                    "Resource not accessible by integration"
                },
                403
              );
            }

            return json(
              { message: "Unhandled" },
              500
            );
          }
        );

        vi.stubGlobal(
          "fetch",
          fetchMock
        );

        await expect(
          submitReview(
            ENV,
            reviewInput(
              "403 test"
            ),
            "xinbaijin-mcp"
          )
        ).rejects.toThrow(
          /Pull requests: Read and write/
        );
      }
    );

    it(
      "creates review.json with all required fields for readback",
      async () => {
        let capturedBlobContent = null;

        const fetchMock = vi.fn(
          async (input, init = {}) => {
            const { pathname } = getUrl(input);
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            if (
              method === "GET" &&
              pathname.endsWith(
                "/git/ref/heads/dev"
              )
            ) {
              return json({
                object: {
                  sha: BRANCH_HEAD
                }
              });
            }

            if (
              method === "GET" &&
              pathname.includes("/commits/")
            ) {
              return json({
                sha: CODE_SHA,
                commit: {
                  tree: {
                    sha: BASE_TREE_SHA
                  }
                },
                files: [
                  {
                    filename:
                      "worker.js",
                    status: "modified"
                  }
                ],
                parents: []
              });
            }

            // Capture blob content
            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/blobs"
              )
            ) {
              capturedBlobContent =
                bodyOf(init)
                  .content;

              return json(
                {
                  sha: "d".repeat(40)
                },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/trees"
              )
            ) {
              return json(
                {
                  sha: "e".repeat(40)
                },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/commits"
              )
            ) {
              return json(
                { sha: REVIEW_SHA },
                201
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/git/refs"
              )
            ) {
              return json(
                {
                  ref: bodyOf(init)
                    .ref,
                  object: {
                    sha: bodyOf(init)
                      .sha
                  }
                },
                201
              );
            }

            if (
              method === "PATCH" &&
              pathname.includes(
                "/git/refs/heads/review/"
              )
            ) {
              return json(
                { ref: "ok" },
                200
              );
            }

            if (
              method === "POST" &&
              pathname.endsWith(
                "/pulls"
              )
            ) {
              return json(
                {
                  html_url:
                    "https://github.com/shunhang776/xinbaijin-mcp/pull/42",
                  number: 42
                },
                201
              );
            }

            return json(
              { message: "Unhandled" },
              500
            );
          }
        );

        vi.stubGlobal(
          "fetch",
          fetchMock
        );

        const result = await submitReview(
          ENV,
          {
            commit: CODE_SHA,
            verdict: "changes_requested",
            summary:
              "Readback test",
            findings: [
              {
                severity: "info",
                file: "test.js",
                line: 1,
                title: "Test finding",
                description:
                  "Finding for readback",
                recommendation:
                  "Check readback"
              }
            ]
          },
          "xinbaijin-mcp"
        );

        // Verify blob content is valid JSON
        expect(
          capturedBlobContent
        ).not.toBeNull();

        const parsed = JSON.parse(
          capturedBlobContent
        );

        // All required fields
        expect(
          parsed.protocol
        ).toBe(
          "xinbaijin-review/1.0"
        );
        expect(
          parsed.repository
        ).toBe(
          "shunhang776/xinbaijin-mcp"
        );
        expect(parsed.branch).toBe(
          "dev"
        );
        expect(
          parsed.reviewed_commit
        ).toBe(CODE_SHA);
        expect(
          parsed.based_on_branch_head
        ).toBe(BRANCH_HEAD);
        expect(parsed.verdict).toBe(
          "changes_requested"
        );
        expect(
          parsed.summary
        ).toBe("Readback test");
        expect(
          parsed.reviewer
        ).toBe("ChatGPT");
        expect(
          typeof parsed.reviewed_at
        ).toBe("string");
        expect(
          parsed.findings
        ).toHaveLength(1);
        expect(
          parsed.findings[0].severity
        ).toBe("info");
        expect(
          parsed.findings[0].file
        ).toBe("test.js");

        // Trailing newline
        expect(
          capturedBlobContent.endsWith(
            "\n"
          )
        ).toBe(true);

        // Returned review_commit matches
        expect(
          result.review_commit
        ).toBe(REVIEW_SHA);
      }
    );

    it(
      "branch name includes a nonce suffix for collision safety",
      async () => {
        const mock = prWritebackMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        const result = await submitReview(
          ENV,
          reviewInput("Nonce test"),
          "xinbaijin-mcp"
        );

        // Branch name format: review/{repo}/{shortSha}-{timestamp}-{nonce}
        expect(
          result.review_branch
        ).toMatch(
          /^review\/xinbaijin-mcp\/aaaaaaa-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/
        );
      }
    );
  }
);
