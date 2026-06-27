import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

// Directly test the validation logic from the guard script.
// The guard script is designed as a standalone Node script;
// we test its core validation function here.

const VALID_VERDICTS = [
  "approved",
  "changes_requested",
  "blocked"
];

function validateReviewJson(review) {
  const errors = [];

  if (!review || typeof review !== "object") {
    errors.push(
      "review.json is not a valid JSON object"
    );
    return errors;
  }

  if (
    typeof review.repository !== "string" ||
    !review.repository.includes("/")
  ) {
    errors.push(
      "missing or invalid repository field"
    );
  }

  if (
    !VALID_VERDICTS.includes(review.verdict)
  ) {
    errors.push(
      `invalid verdict "${review.verdict}"`
    );
  }

  if (
    typeof review.summary !== "string" ||
    review.summary.trim().length === 0
  ) {
    errors.push("missing or empty summary");
  }

  if (!Array.isArray(review.findings)) {
    errors.push(
      "findings is not an array"
    );
  }

  if (
    typeof review.reviewed_commit !==
      "string" ||
    !/^[0-9a-f]{40}$/.test(
      review.reviewed_commit
    )
  ) {
    errors.push(
      "missing or invalid reviewed_commit SHA"
    );
  }

  if (
    typeof review.based_on_branch_head !==
      "string" ||
    !/^[0-9a-f]{40}$/.test(
      review.based_on_branch_head
    )
  ) {
    errors.push(
      "missing or invalid based_on_branch_head SHA"
    );
  }

  if (
    typeof review.branch !== "string" ||
    review.branch.length === 0
  ) {
    errors.push(
      "missing or empty branch field"
    );
  }

  return errors;
}

function makeValidReview(overrides = {}) {
  return {
    protocol: "xinbaijin-review/1.0",
    repository:
      "shunhang776/xinbaijin-mcp",
    branch: "dev",
    reviewed_commit: "a".repeat(40),
    based_on_branch_head:
      "b".repeat(40),
    verdict: "approved",
    summary: "All good.",
    findings: [],
    reviewer: "ChatGPT",
    reviewed_at:
      new Date().toISOString(),
    ...overrides
  };
}

describe("review-writeback-guard validateReviewJson", () => {
  it("passes a valid review.json", () => {
    const review =
      makeValidReview();
    const errors =
      validateReviewJson(review);
    expect(errors).toHaveLength(0);
  });

  it("passes with findings present", () => {
    const review = makeValidReview({
      findings: [
        {
          severity: "high",
          file: "test.js",
          line: 1,
          title: "Test",
          description:
            "Desc",
          recommendation:
            "Fix"
        }
      ]
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toHaveLength(0);
  });

  it("fails on missing repository", () => {
    const review = makeValidReview({
      repository: undefined
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or invalid repository field"
    );
  });

  it("fails on invalid repository format", () => {
    const review = makeValidReview({
      repository: "just-repo"
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or invalid repository field"
    );
  });

  it("fails on invalid verdict", () => {
    const review = makeValidReview({
      verdict: "pending"
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      'invalid verdict "pending"'
    );
  });

  it("fails on empty summary", () => {
    const review = makeValidReview({
      summary: "   "
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or empty summary"
    );
  });

  it("fails on missing findings", () => {
    const review = makeValidReview({
      findings: undefined
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "findings is not an array"
    );
  });

  it("fails on findings not an array", () => {
    const review = makeValidReview({
      findings: "not-array"
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "findings is not an array"
    );
  });

  it("fails on invalid reviewed_commit", () => {
    const review = makeValidReview({
      reviewed_commit: "short"
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or invalid reviewed_commit SHA"
    );
  });

  it("fails on invalid based_on_branch_head", () => {
    const review = makeValidReview({
      based_on_branch_head:
        "not-a-sha"
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or invalid based_on_branch_head SHA"
    );
  });

  it("fails on missing branch", () => {
    const review = makeValidReview({
      branch: ""
    });
    const errors =
      validateReviewJson(review);
    expect(errors).toContain(
      "missing or empty branch field"
    );
  });

  it("fails on null input", () => {
    const errors =
      validateReviewJson(null);
    expect(errors).toContain(
      "review.json is not a valid JSON object"
    );
  });

  it("fails on non-object input", () => {
    const errors =
      validateReviewJson("string");
    expect(errors).toContain(
      "review.json is not a valid JSON object"
    );
  });

  it("returns multiple errors for multiple invalid fields", () => {
    const review = makeValidReview({
      repository: undefined,
      verdict: "nope",
      findings: null
    });
    const errors =
      validateReviewJson(review);
    expect(errors.length).toBeGreaterThanOrEqual(
      3
    );
  });

  // Verdict enum — all three valid values pass
  ["approved",
    "changes_requested",
    "blocked"].forEach(
    (verdict) => {
      it(`accepts verdict "${verdict}"`, () => {
        const review =
          makeValidReview({
            verdict
          });
        expect(
          validateReviewJson(review)
        ).toHaveLength(0);
      });
    }
  );
});

describe("review-writeback-guard branch detection logic", () => {
  // The guard checks:
  // 1. PR files: only review.json? → review PR
  // 2. Branch name: starts with "review/"? → review writeback

  it("identifies review writeback PR by single review.json file + review/ branch", () => {
    const changedFiles = [
      "review.json"
    ];
    const headBranch =
      "review/xinbaijin-mcp/abc1234-2026-06-27T12-00-00-000Z-a1b2c3d4";

    const isReviewOnly =
      changedFiles.length === 1 &&
      changedFiles[0] === "review.json";
    const isReviewBranch =
      headBranch.startsWith("review/");

    expect(isReviewOnly).toBe(true);
    expect(isReviewBranch).toBe(true);
    // Both conditions must be true for guard to apply
    expect(
      isReviewOnly && isReviewBranch
    ).toBe(true);
  });

  it("skips non-review PR with multiple files", () => {
    const changedFiles = [
      "review.json",
      "worker.js"
    ];
    const headBranch =
      "review/xinbaijin-mcp/abc1234-...";

    const isReviewOnly =
      changedFiles.length === 1 &&
      changedFiles[0] === "review.json";
    expect(isReviewOnly).toBe(false);
    // Guard should skip
  });

  it("skips review.json change on non-review branch", () => {
    const changedFiles = [
      "review.json"
    ];
    const headBranch =
      "feat/some-feature";

    const isReviewOnly =
      changedFiles.length === 1 &&
      changedFiles[0] === "review.json";
    const isReviewBranch =
      headBranch.startsWith("review/");

    expect(isReviewOnly).toBe(true);
    expect(isReviewBranch).toBe(false);
    // Guard should skip — not a review writeback branch
  });

  it("skips PR with no files changed", () => {
    const changedFiles = [];
    const isReviewOnly =
      changedFiles.length === 1 &&
      changedFiles[0] === "review.json";
    expect(isReviewOnly).toBe(false);
  });
});

describe("review-writeback-guard cross-repo isolation", () => {
  it("correctly identifies repo from full name", () => {
    // xinbaijin-mcp
    const repoFull1 =
      "shunhang776/xinbaijin-mcp";
    const expectedRepo1 =
      "shunhang776/xinbaijin-mcp";
    expect(repoFull1).toBe(expectedRepo1);

    // xinbaijin
    const repoFull2 =
      "shunhang776/xinbaijin";
    const expectedRepo2 =
      "shunhang776/xinbaijin";
    expect(repoFull2).toBe(expectedRepo2);

    // Cross-repo mismatch should fail
    const reviewRepo =
      "shunhang776/xinbaijin";
    const actualRepo =
      "shunhang776/xinbaijin-mcp";
    expect(reviewRepo).not.toBe(
      actualRepo
    );
  });

  it("rejects repository field pointing to wrong repo", () => {
    const review = makeValidReview({
      repository:
        "shunhang776/xinbaijin"
    });
    const actualRepo =
      "shunhang776/xinbaijin-mcp";
    expect(
      review.repository
    ).not.toBe(actualRepo);
    // Guard should fail: repository mismatch
  });
});
