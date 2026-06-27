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
  let headReadCount = 0;

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
        headReadCount++;

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

      // POST create branch ref
      if (
        method === "POST" &&
        pathname.endsWith("/git/refs")
      ) {
        const body = bodyOf(init);

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

      // PATCH update review branch
      if (
        method === "PATCH" &&
        pathname.includes(
          "/git/refs/heads/review/"
        )
      ) {
        return json({
          ref: pathname
            .split("/git/")[1]
            .replace("refs/", "refs/"),
          object: {
            sha: bodyOf(init).sha
          }
        });
      }

      // POST create PR
      if (
        method === "POST" &&
        pathname.endsWith("/pulls")
      ) {
        return json(
          {
            html_url:
              "https://github.com/shunhang776/xinbaijin/pull/99",
            number: 99
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
    getHead: () => head,
    getHeadReadCount: () => headReadCount
  };
}

function pushDuringReviewMock() {
  let head = CODE_SHA;

  const reviewSha = "3".repeat(40);

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
        // External push happens while review is in progress.
        head = NEW_CODE_SHA;

        return json({
          sha: reviewSha
        });
      }

      // POST create branch ref
      if (
        method === "POST" &&
        pathname.endsWith("/git/refs")
      ) {
        return json(
          {
            ref: bodyOf(init).ref,
            object: {
              sha: bodyOf(init).sha
            }
          },
          201
        );
      }

      // PATCH update review branch
      if (
        method === "PATCH" &&
        pathname.includes(
          "/git/refs/heads/review/"
        )
      ) {
        return json({
          ref: "ok",
          object: {
            sha: bodyOf(init).sha
          }
        });
      }

      // POST create PR
      if (
        method === "POST" &&
        pathname.endsWith("/pulls")
      ) {
        return json(
          {
            html_url:
              "https://github.com/shunhang776/xinbaijin/pull/1",
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
      "allows both concurrent reviews (PR mode does not race on dev ref)",
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
              reviewInput("review A"),
              "xinbaijin"
            ),
            submitReview(
              ENV,
              reviewInput("review B"),
              "xinbaijin"
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

        // Both succeed — separate review branches,
        // no shared dev ref mutation.
        expect(fulfilled).toHaveLength(2);
        expect(rejected).toHaveLength(0);

        expect(
          fulfilled[0].value.writeback_mode
        ).toBe("pr");
        expect(
          fulfilled[1].value.writeback_mode
        ).toBe("pr");

        // dev head never changed
        expect(mock.getHead()).toBe(
          CODE_SHA
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
            reviewInput("old review"),
            "xinbaijin"
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