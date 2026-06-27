/**
 * Review Writeback Guard — Merge-Stale Protection
 * ================================================
 *
 * When submit_review creates a PR that writes review.json, this guard
 * MUST pass before the PR can be squash-merged into dev. It verifies:
 *
 *   1. The PR only modifies review.json (or is a review-only PR).
 *   2. review.json.repository matches the actual repository.
 *   3. review.json.reviewed_commit is still the latest reviewable
 *      code commit on dev (not stale).
 *   4. review.json.based_on_branch_head equals the current dev HEAD
 *      (ensuring the review was written against the exact state it
 *      intends to land on).
 *   5. review.json.verdict is one of the three valid verdicts.
 *   6. review.json.summary and findings are present and structurally
 *      legal.
 *
 * Designed to run as a GitHub Actions workflow on pull_request events
 * targeting dev. Can be added as a Required Status Check in branch
 * protection rules to enforce review PRs cannot merge stale reviews.
 *
 * FAIL-CLOSED DESIGN:
 * Any missing token, API error, unexpected HTTP status, missing or
 * malformed review.json, or validation failure results in a non-zero
 * exit code.
 *
 * NON-REVIEW PRs (those that change files beyond review.json) are
 * skipped with exit code 0 — they're code changes, not review
 * writebacks.
 */

import https from "https";
import { REPOSITORIES } from "../review-core.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOKEN = process.env.REVIEW_GUARD_TOKEN || process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const PR_BASE = process.env.PR_BASE || "dev";
const PR_HEAD_SHA = process.env.PR_HEAD_SHA;
const REPO_FULL = process.env.REPO_FULL; // e.g. "shunhang776/xinbaijin-mcp"

const VALID_VERDICTS = ["approved", "changes_requested", "blocked"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiRequest(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "review-writeback-guard",
        "Authorization": "Bearer " + token
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function fail(reason) {
  console.log(`REVIEW_GUARD FAIL: ${reason}`);
  process.exitCode = 1;
}

function pass(msg) {
  console.log(`REVIEW_GUARD PASS: ${msg}`);
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

function validateReviewJson(review) {
  const errors = [];

  if (!review || typeof review !== "object") {
    errors.push("review.json is not a valid JSON object");
    return errors;
  }

  // Repository
  if (typeof review.repository !== "string" || !review.repository.includes("/")) {
    errors.push("missing or invalid repository field");
  }

  // Verdict
  if (!VALID_VERDICTS.includes(review.verdict)) {
    errors.push(`invalid verdict "${review.verdict}"`);
  }

  // Summary
  if (typeof review.summary !== "string" || review.summary.trim().length === 0) {
    errors.push("missing or empty summary");
  }

  // Findings
  if (!Array.isArray(review.findings)) {
    errors.push("findings is not an array");
  }

  // Reviewed commit
  if (typeof review.reviewed_commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(review.reviewed_commit)) {
    errors.push("missing or invalid reviewed_commit SHA");
  }

  // Based on branch head
  if (typeof review.based_on_branch_head !== "string" ||
      !/^[0-9a-f]{40}$/.test(review.based_on_branch_head)) {
    errors.push("missing or invalid based_on_branch_head SHA");
  }

  // Branch
  if (typeof review.branch !== "string" || review.branch.length === 0) {
    errors.push("missing or empty branch field");
  }

  return errors;
}

/**
 * Get the latest non-review-only commit SHA on a branch.
 * Walk parents until we find a commit whose files are not all review.json.
 */
async function getLatestReviewableCommitSha(token, owner, repo, branchName) {
  // First get the branch HEAD
  const { status: refStatus, body: refBody } = await apiRequest(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branchName)}`
  );

  if (refStatus !== 200) {
    throw new Error(`Failed to read branch head: HTTP ${refStatus}`);
  }

  let currentSha;
  try {
    currentSha = JSON.parse(refBody).object.sha;
  } catch {
    throw new Error("Failed to parse branch head response");
  }

  const MAX_WALK = 100;
  const visited = new Set();

  for (let step = 0; step < MAX_WALK; step++) {
    if (visited.has(currentSha)) {
      throw new Error("Commit history cycle detected");
    }
    visited.add(currentSha);

    const { status: commitStatus, body: commitBody } = await apiRequest(
      token,
      `/repos/${owner}/${repo}/commits/${currentSha}`
    );

    if (commitStatus !== 200) {
      throw new Error(`Failed to read commit ${currentSha}: HTTP ${commitStatus}`);
    }

    let commit;
    try {
      commit = JSON.parse(commitBody);
    } catch {
      throw new Error(`Failed to parse commit ${currentSha}`);
    }

    const files = Array.isArray(commit.files) ? commit.files : [];
    const isReviewOnly = files.length > 0 &&
      files.every((f) => f.filename === "review.json");

    if (!isReviewOnly) {
      return currentSha;
    }

    // Follow first parent
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    if (parents.length === 0) {
      // Root commit with only review.json — unusual but possible
      return currentSha;
    }

    currentSha = parents[0].sha;
  }

  throw new Error(`Exceeded MAX_WALK (${MAX_WALK}) without finding a code commit`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Review Writeback Guard ===");

  // --- Token check (fail-closed) ---
  if (!TOKEN) {
    fail("REVIEW_GUARD_TOKEN (or GITHUB_TOKEN) is not set.");
    return;
  }

  // --- Env check ---
  if (!PR_NUMBER || !PR_HEAD_SHA || !REPO_FULL) {
    fail("PR_NUMBER, PR_HEAD_SHA, and REPO_FULL must be set in environment.");
    return;
  }

  const [owner, repo] = REPO_FULL.split("/");

  // --- Step 1: Get PR files ---
  console.log(`PR #${PR_NUMBER} → base=${PR_BASE} head=${PR_HEAD_SHA.slice(0, 7)}`);

  const { status: prStatus, body: prBody } = await apiRequest(
    TOKEN,
    `/repos/${REPO_FULL}/pulls/${PR_NUMBER}`
  );

  if (prStatus !== 200) {
    fail(`Failed to read PR #${PR_NUMBER}: HTTP ${prStatus}`);
    return;
  }

  let prData;
  try {
    prData = JSON.parse(prBody);
  } catch {
    fail(`Failed to parse PR #${PR_NUMBER} response`);
    return;
  }

  // --- Step 2: Determine if this is a review writeback PR ---
  // A review writeback PR is one that ONLY changes review.json.
  // We also check if the branch name starts with "review/" as a hint.
  const headBranch = prData.head?.ref || "";
  const rawFiles = await apiRequest(
    TOKEN,
    `/repos/${REPO_FULL}/pulls/${PR_NUMBER}/files`
  );

  let files = [];
  try {
    files = JSON.parse(rawFiles.body);
  } catch {
    fail("Failed to read PR files list");
    return;
  }

  const changedFiles = Array.isArray(files)
    ? files.map((f) => f.filename)
    : [];

  console.log(`Changed files: ${changedFiles.join(", ") || "(none)"}`);

  // Only gate review.json-only PRs. Code PRs pass through.
  if (!(changedFiles.length === 1 && changedFiles[0] === "review.json")) {
    pass("not a review-only PR — guard does not apply");
    return;
  }

  if (!headBranch.startsWith("review/")) {
    pass("review.json change but branch is not review/* — guard does not apply");
    return;
  }

  console.log(`Detected review writeback PR (branch: ${headBranch})`);

  // --- Step 3: Read review.json from PR head ---
  const { status: fileStatus, body: fileBody } = await apiRequest(
    TOKEN,
    `/repos/${REPO_FULL}/contents/review.json?ref=${encodeURIComponent(PR_HEAD_SHA)}`
  );

  if (fileStatus !== 200) {
    fail(`Failed to read review.json from PR head: HTTP ${fileStatus}`);
    return;
  }

  let fileData;
  try {
    fileData = JSON.parse(fileBody);
  } catch {
    fail("Failed to parse review.json GitHub API response");
    return;
  }

  if (fileData.encoding !== "base64" || typeof fileData.content !== "string") {
    fail("review.json is not base64-encoded in GitHub API response");
    return;
  }

  const cleanBase64 = fileData.content.replace(/\s/g, "");
  let review;
  try {
    const decoded = Buffer.from(cleanBase64, "base64").toString("utf-8");
    review = JSON.parse(decoded);
  } catch (e) {
    fail(`Failed to decode/parse review.json: ${e.message}`);
    return;
  }

  // --- Step 4: Validate review.json structure ---
  const errors = validateReviewJson(review);
  if (errors.length > 0) {
    for (const err of errors) {
      fail(`review.json field validation: ${err}`);
    }
    return;
  }
  pass("review.json structure valid");

  // --- Step 5: Cross-repo check ---
  const expectedRepo = `${owner}/${repo}`;
  if (review.repository !== expectedRepo) {
    fail(
      `repository mismatch: review.json says "${review.repository}" but PR target is "${expectedRepo}"`
    );
    return;
  }
  pass(`repository matches: ${expectedRepo}`);

  // --- Step 6: Verify based_on_branch_head === current dev HEAD ---
  const { status: refStatus2, body: refBody2 } = await apiRequest(
    TOKEN,
    `/repos/${REPO_FULL}/git/ref/heads/${encodeURIComponent(PR_BASE)}`
  );

  if (refStatus2 !== 200) {
    fail(`Failed to read ${PR_BASE} branch head: HTTP ${refStatus2}`);
    return;
  }

  let currentDevHead;
  try {
    currentDevHead = JSON.parse(refBody2).object.sha;
  } catch {
    fail("Failed to parse dev branch head response");
    return;
  }

  if (review.based_on_branch_head.toLowerCase() !== currentDevHead.toLowerCase()) {
    fail(
      `based_on_branch_head mismatch: ` +
      `review.json says ${review.based_on_branch_head.slice(0, 7)} ` +
      `but current ${PR_BASE} HEAD is ${currentDevHead.slice(0, 7)}. ` +
      `Dev has moved since this review was written — the review is stale.`
    );
    return;
  }
  pass(`based_on_branch_head matches current ${PR_BASE} HEAD`);

  // --- Step 7: Verify reviewed_commit is latest reviewable code commit ---
  let latestCodeCommit;
  try {
    latestCodeCommit = await getLatestReviewableCommitSha(
      TOKEN, owner, repo, PR_BASE
    );
  } catch (e) {
    fail(`Failed to find latest reviewable code commit: ${e.message}`);
    return;
  }

  if (review.reviewed_commit.toLowerCase() !== latestCodeCommit.toLowerCase()) {
    fail(
      `reviewed_commit mismatch: ` +
      `review.json says ${review.reviewed_commit.slice(0, 7)} ` +
      `but latest reviewable code commit on ${PR_BASE} is ${latestCodeCommit.slice(0, 7)}. ` +
      `New code has landed since this review was written — the review is stale.`
    );
    return;
  }
  pass(`reviewed_commit is latest reviewable code commit on ${PR_BASE}`);

  // --- Step 8: All checks passed ---
  console.log("\n=== Review Writeback Guard: PASSED ===");
}

main().catch((err) => {
  console.error(`REVIEW_GUARD FAIL: ${err.message}`);
  process.exit(1);
});
