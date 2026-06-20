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
const NEW_CODE_SHA = "b".repeat(40);
const BASE_TREE_SHA = "c".repeat(40);

const ENV = {
  GITHUB_OWNER: "test-owner",
  GITHUB_REPO: "test-repo",
  GITHUB_BRANCH: "dev",
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

function commitDetails(sha) {
  return {
    sha,
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
  };
}

function barrier(size) {
  let count = 0;
  let release;

  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return async () => {
    count += 1;

    if (count === size) {
      release();
    }

    await promise;
  };
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

function concurrentMock() {
  let head = CODE_SHA;
  let blobNo = 0;
  let treeNo = 0;
  let commitNo = 0;

  const parents = new Map();
  const waitForTwoHeads = barrier(2);

  const fetchMock = vi.fn(
    async (input, init = {}) => {
      const { pathname } = getUrl(input);
      const method = String(
        init.method || "GET"
      ).toUpperCase();

      if (
        method === "GET" &&
        pathname.endsWith("/git/ref/heads/dev")
      ) {
        const observed = head;

        await waitForTwoHeads();

        return json({
          object: {
            sha: observed
          }
        });
      }

      if (
        method === "GET" &&
        pathname.includes("/commits/")
      ) {
        const sha = decodeURIComponent(
          pathname.split("/commits/")[1]
        );

        return json(commitDetails(sha));
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/blobs")
      ) {
        blobNo += 1;

        return json({
          sha: String(blobNo).padStart(40, "d")
        });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/trees")
      ) {
        treeNo += 1;

        return json({
          sha: String(treeNo).padStart(40, "e")
        });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/commits")
      ) {
        commitNo += 1;

        const sha =
          (
            commitNo === 1
              ? "1"
              : "2"
          ).repeat(40);

        parents.set(
          sha,
          bodyOf(init).parents[0]
        );

        return json({ sha });
      }

      if (
        method === "PATCH" &&
        pathname.endsWith("/git/refs/heads/dev")
      ) {
        const candidate = bodyOf(init).sha;

        if (parents.get(candidate) !== head) {
          return json(
            {
              message:
                "Update is not a fast forward"
            },
            422
          );
        }

        head = candidate;

        return json({
          ref: "refs/heads/dev",
          object: {
            sha: candidate
          }
        });
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
    getHead: () => head
  };
}

function pushDuringReviewMock() {
  let head = CODE_SHA;

  const reviewSha = "3".repeat(40);
  const parents = new Map();

  const fetchMock = vi.fn(
    async (input, init = {}) => {
      const { pathname } = getUrl(input);
      const method = String(
        init.method || "GET"
      ).toUpperCase();

      if (
        method === "GET" &&
        pathname.endsWith("/git/ref/heads/dev")
      ) {
        return json({
          object: {
            sha: head
          }
        });
      }

      if (
        method === "GET" &&
        pathname.includes("/commits/")
      ) {
        const sha = decodeURIComponent(
          pathname.split("/commits/")[1]
        );

        return json(commitDetails(sha));
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/blobs")
      ) {
        return json({
          sha: "d".repeat(40)
        });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/trees")
      ) {
        return json({
          sha: "e".repeat(40)
        });
      }

      if (
        method === "POST" &&
        pathname.endsWith("/git/commits")
      ) {
        parents.set(
          reviewSha,
          bodyOf(init).parents[0]
        );

        head = NEW_CODE_SHA;

        return json({
          sha: reviewSha
        });
      }

      if (
        method === "PATCH" &&
        pathname.endsWith("/git/refs/heads/dev")
      ) {
        const candidate = bodyOf(init).sha;

        if (parents.get(candidate) !== head) {
          return json(
            {
              message:
                "Update is not a fast forward"
            },
            422
          );
        }

        head = candidate;

        return json({
          object: {
            sha: candidate
          }
        });
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
    getHead: () => head
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(
  "submitReview race protection",
  () => {
    it(
      "allows only one of two reviews based on the same branch head",
      async () => {
        const mock = concurrentMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        const results =
          await Promise.allSettled([
            submitReview(
              ENV,
              reviewInput("review A")
            ),
            submitReview(
              ENV,
              reviewInput("review B")
            )
          ]);

        const fulfilled = results.filter(
          (result) =>
            result.status === "fulfilled"
        );

        const rejected = results.filter(
          (result) =>
            result.status === "rejected"
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        expect(
          rejected[0].reason.message
        ).toContain(
          "Concurrent branch update detected"
        );

        expect(
          mock.getHead()
        ).toBe(
          fulfilled[0].value.review_commit
        );
      }
    );

    it(
      "rejects an old review when new code is pushed before publication",
      async () => {
        const mock =
          pushDuringReviewMock();

        vi.stubGlobal(
          "fetch",
          mock.fetchMock
        );

        await expect(
          submitReview(
            ENV,
            reviewInput("old review")
          )
        ).rejects.toThrow(
          "Concurrent branch update detected"
        );

        expect(
          mock.getHead()
        ).toBe(NEW_CODE_SHA);
      }
    );
  }
);