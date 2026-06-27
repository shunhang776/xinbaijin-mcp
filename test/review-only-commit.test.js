import {
  describe,
  expect,
  it
} from "vitest";

import {
  isReviewOnlyCommit
} from "../review-core.js";

describe("isReviewOnlyCommit", () => {
  it("returns true when the commit only modifies review.json", () => {
    expect(
      isReviewOnlyCommit({
        files: [
          { filename: "review.json", status: "modified" }
        ]
      })
    ).toBe(true);
  });

  it("returns false when the commit includes other files", () => {
    expect(
      isReviewOnlyCommit({
        files: [
          { filename: "review.json", status: "modified" },
          { filename: "worker.js", status: "modified" }
        ]
      })
    ).toBe(false);
  });

  it("returns false when files is missing", () => {
    expect(
      isReviewOnlyCommit({})
    ).toBe(false);
  });

  it("returns false when files is not an array", () => {
    expect(
      isReviewOnlyCommit({ files: null })
    ).toBe(false);

    expect(
      isReviewOnlyCommit({ files: "not-an-array" })
    ).toBe(false);
  });

  it("returns false when files is an empty array", () => {
    expect(
      isReviewOnlyCommit({ files: [] })
    ).toBe(false);
  });
});
