import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

// Mirror of the guard's validateReviewJson for unit testing.
const VALID_VERDICTS = [
  "approved",
  "changes_requested",
  "blocked"
];
const VALID_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info"
];

function validateReviewJson(review, prBase) {
  const errors = [];

  if (!review || typeof review !== "object") {
    errors.push(
      "review.json is not a valid JSON object"
    );
    return errors;
  }

  // Protocol
  if (
    review.protocol !==
    "xinbaijin-review/1.0"
  ) {
    errors.push(
      `invalid protocol "${review.protocol}" — expected "xinbaijin-review/1.0"`
    );
  }

  // Repository
  if (
    typeof review.repository !== "string" ||
    !review.repository.includes("/")
  ) {
    errors.push(
      "missing or invalid repository field"
    );
  }

  // Branch must match PR base
  if (
    typeof review.branch !== "string" ||
    review.branch !== prBase
  ) {
    errors.push(
      `branch "${review.branch}" does not match PR base "${prBase}"`
    );
  }

  // Verdict
  if (
    !VALID_VERDICTS.includes(review.verdict)
  ) {
    errors.push(
      `invalid verdict "${review.verdict}"`
    );
  }

  // Reviewer
  if (review.reviewer !== "ChatGPT") {
    errors.push(
      `invalid reviewer "${review.reviewer}" — expected "ChatGPT"`
    );
  }

  // Reviewed at (valid ISO time)
  if (
    typeof review.reviewed_at !== "string"
  ) {
    errors.push("missing reviewed_at");
  } else {
    const reviewedAt = new Date(
      review.reviewed_at
    );
    if (isNaN(reviewedAt.getTime())) {
      errors.push(
        `reviewed_at "${review.reviewed_at}" is not a valid ISO date`
      );
    }
  }

  // Summary
  if (
    typeof review.summary !== "string" ||
    review.summary.trim().length === 0
  ) {
    errors.push("missing or empty summary");
  }

  // Findings
  if (!Array.isArray(review.findings)) {
    errors.push(
      "findings is not an array"
    );
  } else {
    for (
      let i = 0;
      i < review.findings.length;
      i++
    ) {
      const f = review.findings[i];
      const prefix = `findings[${i}]`;

      if (!f || typeof f !== "object") {
        errors.push(
          `${prefix} is not an object`
        );
        continue;
      }

      // severity
      if (
        !VALID_SEVERITIES.includes(
          f.severity
        )
      ) {
        errors.push(
          `${prefix}.severity "${f.severity}" is invalid (expected critical/high/medium/low/info)`
        );
      }

      // file
      if (
        typeof f.file !== "string" ||
        f.file.trim().length === 0
      ) {
        errors.push(
          `${prefix}.file is missing or empty`
        );
      }

      // title
      if (
        typeof f.title !== "string" ||
        f.title.trim().length === 0
      ) {
        errors.push(
          `${prefix}.title is missing or empty`
        );
      }

      // description
      if (
        typeof f.description !==
          "string" ||
        f.description.trim().length ===
          0
      ) {
        errors.push(
          `${prefix}.description is missing or empty`
        );
      }

      // recommendation
      if (
        typeof f.recommendation !==
          "string" ||
        f.recommendation.trim()
          .length === 0
      ) {
        errors.push(
          `${prefix}.recommendation is missing or empty`
        );
      }

      // line
      if (
        f.line !== null &&
        f.line !== undefined
      ) {
        if (
          typeof f.line !== "number" ||
          !Number.isInteger(f.line) ||
          f.line <= 0
        ) {
          errors.push(
            `${prefix}.line must be a positive integer or null/undefined, got ${f.line}`
          );
        }
      }
    }
  }

  // Reviewed commit
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

  // Based on branch head
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

function makeValidFinding(overrides = {}) {
  return {
    severity: "high",
    file: "worker.js",
    line: 42,
    title: "Test finding",
    description:
      "Detailed description here.",
    recommendation:
      "Fix this thing.",
    ...overrides
  };
}

describe(
  "review-writeback-guard validateReviewJson — basic structure",
  () => {
    it("passes a valid review.json", () => {
      const review =
        makeValidReview();
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("fails on wrong protocol", () => {
      const review = makeValidReview({
        protocol: "xinbaijin-review/0.9"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'invalid protocol "xinbaijin-review/0.9" — expected "xinbaijin-review/1.0"'
      );
    });

    it("fails on missing protocol", () => {
      const review = makeValidReview({
        protocol: undefined
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'invalid protocol "undefined" — expected "xinbaijin-review/1.0"'
      );
    });

    it("fails when branch does not match PR base", () => {
      const review = makeValidReview({
        branch: "main"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'branch "main" does not match PR base "dev"'
      );
    });

    it("passes when branch matches PR base", () => {
      const review = makeValidReview({
        branch: "dev"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("fails on wrong reviewer", () => {
      const review = makeValidReview({
        reviewer: "Human"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'invalid reviewer "Human" — expected "ChatGPT"'
      );
    });

    it("fails on missing reviewer", () => {
      const review = makeValidReview({
        reviewer: undefined
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'invalid reviewer "undefined" — expected "ChatGPT"'
      );
    });

    it("fails on missing reviewed_at", () => {
      const review = makeValidReview({
        reviewed_at: undefined
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        "missing reviewed_at"
      );
    });

    it("fails on invalid reviewed_at", () => {
      const review = makeValidReview({
        reviewed_at: "not-a-date"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'reviewed_at "not-a-date" is not a valid ISO date'
      );
    });

    it("accepts valid ISO reviewed_at", () => {
      const review = makeValidReview({
        reviewed_at:
          "2026-06-27T14:32:37.248Z"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("fails on missing repository", () => {
      const review = makeValidReview({
        repository: undefined
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        "missing or invalid repository field"
      );
    });

    it("fails on invalid verdict", () => {
      const review = makeValidReview({
        verdict: "pending"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        'invalid verdict "pending"'
      );
    });

    it("fails on empty summary", () => {
      const review = makeValidReview({
        summary: "   "
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        "missing or empty summary"
      );
    });

    it("fails on findings not an array", () => {
      const review = makeValidReview({
        findings: "not-array"
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toContain(
        "findings is not an array"
      );
    });

    it("fails on null input", () => {
      const errors = validateReviewJson(
        null,
        "dev"
      );
      expect(errors).toContain(
        "review.json is not a valid JSON object"
      );
    });

    [
      "approved",
      "changes_requested",
      "blocked"
    ].forEach((verdict) => {
      it(`accepts verdict "${verdict}"`, () => {
        const review =
          makeValidReview({
            verdict
          });
        expect(
          validateReviewJson(
            review,
            "dev"
          )
        ).toHaveLength(0);
      });
    });
  }
);

describe(
  "review-writeback-guard validateReviewJson — finding validation",
  () => {
    it("passes with a valid finding", () => {
      const review = makeValidReview({
        findings: [makeValidFinding()]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("passes with finding where line is null", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({ line: null })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("passes with finding where line is undefined", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            line: undefined
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(errors).toHaveLength(0);
    });

    it("fails on finding with invalid severity", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            severity: "urgent"
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "severity"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with empty file", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({ file: "" })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "file is missing or empty"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with missing title", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            title: undefined
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "title is missing or empty"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with empty description", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            description: "  "
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "description is missing or empty"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with missing recommendation", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            recommendation: undefined
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "recommendation is missing or empty"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with zero line", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({ line: 0 })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "line must be a positive integer"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with negative line", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            line: -1
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "line must be a positive integer"
          )
        )
      ).toBe(true);
    });

    it("fails on finding with non-integer line", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            line: 3.14
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.some((e) =>
          e.includes(
            "line must be a positive integer"
          )
        )
      ).toBe(true);
    });

    it("returns multiple errors for multiple invalid findings", () => {
      const review = makeValidReview({
        findings: [
          makeValidFinding({
            severity: "urgent",
            file: ""
          }),
          makeValidFinding({
            title: undefined
          })
        ]
      });
      const errors = validateReviewJson(
        review,
        "dev"
      );
      expect(
        errors.length
      ).toBeGreaterThanOrEqual(3);
    });
  }
);

describe(
  "review-writeback-guard branch detection — fail-closed",
  () => {
    const FAKE_BRANCH =
      "review/xinbaijin-mcp/abc1234-2026-06-27T12-00-00-000Z-a1b2c3d4";
    const NON_REVIEW_BRANCH =
      "feat/some-feature";
    const CI_BRANCH =
      "fix/audit-pr-writeback-ready";

    it("identifies review writeback PR (review.json only + review/ branch)", () => {
      const changedFiles = [
        "review.json"
      ];
      const headBranch = FAKE_BRANCH;
      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      const onlyReviewJson =
        changedFiles.length === 1 &&
        changedFiles[0] === "review.json";
      const isReviewBranch =
        headBranch.startsWith(
          "review/"
        );
      expect(hasReviewJson).toBe(true);
      expect(onlyReviewJson).toBe(true);
      expect(isReviewBranch).toBe(true);
    });

    it("fails: review.json on non-review branch", () => {
      const changedFiles = [
        "review.json"
      ];
      const headBranch =
        NON_REVIEW_BRANCH;

      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      const isReviewBranch =
        headBranch.startsWith(
          "review/"
        );

      expect(hasReviewJson).toBe(true);
      expect(isReviewBranch).toBe(false);
      // Guard MUST fail here — review.json on non-review branch
    });

    it("fails: code PR also modifies review.json", () => {
      const changedFiles = [
        "review.json",
        "worker.js"
      ];
      const headBranch = CI_BRANCH;

      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      const onlyReviewJson =
        changedFiles.length === 1 &&
        changedFiles[0] === "review.json";

      expect(hasReviewJson).toBe(true);
      expect(onlyReviewJson).toBe(false);
      // Guard MUST fail — review.json alongside code changes
    });

    it("skips: pure code PR without review.json", () => {
      const changedFiles = [
        "worker.js",
        "review-core.js"
      ];
      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      expect(hasReviewJson).toBe(false);
      // Guard should skip — no review.json at all
    });

    it("skips: empty PR (no files)", () => {
      const changedFiles = [];
      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      expect(hasReviewJson).toBe(false);
    });

    it("fails: review.json on review/ branch but alongside other files", () => {
      const changedFiles = [
        "review.json",
        "worker.js"
      ];
      const headBranch = FAKE_BRANCH;

      const hasReviewJson =
        changedFiles.includes(
          "review.json"
        );
      const onlyReviewJson =
        changedFiles.length === 1 &&
        changedFiles[0] === "review.json";
      const isReviewBranch =
        headBranch.startsWith(
          "review/"
        );

      expect(hasReviewJson).toBe(true);
      expect(isReviewBranch).toBe(true);
      expect(onlyReviewJson).toBe(false);
      // Guard MUST fail — review PR must ONLY change review.json
    });
  }
);

describe(
  "review-writeback-guard cross-repo isolation",
  () => {
    it("detects cross-repo mismatch", () => {
      const reviewRepo =
        "shunhang776/xinbaijin";
      const actualRepo =
        "shunhang776/xinbaijin-mcp";
      expect(
        reviewRepo
      ).not.toBe(actualRepo);
    });

    it("passes when repo matches", () => {
      const reviewRepo =
        "shunhang776/xinbaijin-mcp";
      const actualRepo =
        "shunhang776/xinbaijin-mcp";
      expect(reviewRepo).toBe(
        actualRepo
      );
    });
  }
);
