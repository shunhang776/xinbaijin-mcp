import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  getLatestReviewableCommit
} from "../review-core.js";

const ENV = {
  GITHUB_OWNER: "test-owner",
  GITHUB_REPO: "test-repo",
  GITHUB_BRANCH: "dev",
  GITHUB_TOKEN: "test-token"
};

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

describe(
  "getLatestReviewableCommit history lookup",
  () => {
    it(
      "uses review.json metadata to jump across a long review-only history",
      async () => {
        const headSha = sha(30);
        const codeSha = sha(1);

        const metadata = Buffer.from(
          JSON.stringify({
            reviewed_commit: codeSha
          }),
          "utf8"
        ).toString("base64");

        const fetchMock = vi.fn(
          async (input, init = {}) => {
            const { pathname } = getUrl(input);
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            if (
              method === "GET" &&
              pathname.endsWith(
                `/commits/${headSha}`
              )
            ) {
              return json(
                reviewCommit(
                  headSha,
                  sha(29)
                )
              );
            }

            if (
              method === "GET" &&
              pathname.endsWith(
                `/contents/review.json`
              )
            ) {
              return json({
                type: "file",
                encoding: "base64",
                content: metadata
              });
            }

            if (
              method === "GET" &&
              pathname.endsWith(
                `/commits/${codeSha}`
              )
            ) {
              return json(
                codeCommit(codeSha)
              );
            }

            if (
              method === "GET" &&
              pathname.includes(
                `/compare/${codeSha}...${headSha}`
              )
            ) {
              return json({
                status: "ahead"
              });
            }

            // Intermediate review-only commits (999 down to 2)
            if (
              method === "GET" &&
              pathname.includes("/commits/")
            ) {
              const reqSha = decodeURIComponent(
                pathname.split("/commits/")[1]
              );
              const num = parseInt(reqSha, 16);
              if (num >= 2 && num <= 999) {
                return json(
                  reviewCommit(reqSha, sha(num - 1))
                );
              }
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

        const result =
          await getLatestReviewableCommit(
            ENV,
            headSha,
            "xinbaijin-mcp"
          );

        expect(result.sha).toBe(codeSha);

        // Fast-path walker + fallback traverse the full review-only chain.
        // The exact count depends on MAX_FAST_PATH_WALK; just verify we
        // read more than the 2-commit fast-path minimum.
        const commitReads =
          fetchMock.mock.calls.filter(
            ([input]) =>
              getUrl(input).pathname.includes(
                "/commits/"
              )
          );
        expect(commitReads.length).toBeGreaterThan(2);
      }
    );

    it(
      "falls back through more than 20 review-only commits",
      async () => {
        const reviewCount = 25;
        const codeSha = sha(5000);

        const reviewShas =
          Array.from(
            { length: reviewCount },
            (_, index) => sha(index + 1)
          );

        const commits = new Map();

        reviewShas.forEach(
          (commitSha, index) => {
            const parentSha =
              index === reviewShas.length - 1
                ? codeSha
                : reviewShas[index + 1];

            commits.set(
              commitSha,
              reviewCommit(
                commitSha,
                parentSha
              )
            );
          }
        );

        commits.set(
          codeSha,
          codeCommit(codeSha)
        );

        const fetchMock = vi.fn(
          async (input, init = {}) => {
            const url = getUrl(input);
            const { pathname } = url;
            const method = String(
              init.method || "GET"
            ).toUpperCase();

            if (
              method === "GET" &&
              pathname.endsWith(
                "/contents/review.json"
              )
            ) {
              return json(
                { message: "Not Found" },
                404
              );
            }

            if (
              method === "GET" &&
              pathname.includes("/commits/")
            ) {
              const commitSha =
                decodeURIComponent(
                  pathname.split(
                    "/commits/"
                  )[1]
                );

              const commit =
                commits.get(commitSha);

              return commit
                ? json(commit)
                : json(
                    { message: "Not Found" },
                    404
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

        const result =
          await getLatestReviewableCommit(
            ENV,
            reviewShas[0],
            "xinbaijin-mcp"
          );

        expect(result.sha).toBe(codeSha);

        const commitReads =
          fetchMock.mock.calls.filter(
            ([input]) =>
              getUrl(input).pathname.includes(
                "/commits/"
              )
          );

        expect(commitReads).toHaveLength(
          reviewCount + 1
        );
      }
    );
  }
);