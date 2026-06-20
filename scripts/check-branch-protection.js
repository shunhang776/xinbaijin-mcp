/**
 * Branch Protection Check — TOCTOU Mitigation
 * =============================================
 *
 * The submit_review tool in review-core.js uses a re-read + PATCH pattern
 * (updateBranchRefFastForward) that is NOT an atomic compare-and-swap. A
 * race window remains between the re-read and the PATCH where an attacker
 * (or another process) could force-push the protected branch, causing the
 * review commit to land on an unexpected parent commit.
 *
 * This script verifies that GitHub branch protection is properly configured
 * on every repository's configured branch to close that TOCTOU window:
 *
 *   - allow_force_pushes must be explicitly disabled (enabled === false)
 *   - allow_deletions   must be explicitly disabled (enabled === false)
 *   - enforce_admins    must be explicitly enabled  (enabled === true)
 *                       CRITICAL: without this, admins can bypass
 *
 * Without these protections, the re-read + force:false PATCH in
 * updateBranchRefFastForward is not sufficient to guarantee that the
 * review commit always has the expected parent.
 *
 * FAIL-CLOSED DESIGN:
 * Any missing token, API error, unexpected HTTP status, JSON parse failure,
 * missing/unexpected response fields, or protection misconfiguration results
 * in a non-zero exit code. Only explicit correct values on ALL three fields
 * for every repository counts as a PASS.
 *
 * Pass --allow-skip to downgrade missing-token and 404 (branch protection
 * not configured) from FAIL to SKIP. All other failure modes remain hard
 * FAILs regardless of --allow-skip.
 */

import https from "https";
import { REPOSITORIES } from "../review-core.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOKEN = process.env.BRANCH_PROTECTION_TOKEN || process.env.GITHUB_TOKEN;
const ALLOW_SKIP = process.argv.includes("--allow-skip");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Perform a GET request against the GitHub REST API.
 * Returns { status, body } where body is the raw response text.
 * Headers match production (review-core.js githubHeaders).
 */
function apiRequest(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "check-branch-protection",
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
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

/**
 * Check a single branch-protection field.
 * Returns true on PASS, false on FAIL (prints result inline).
 *
 * @param {object}  protection      - Parsed JSON response from GitHub API.
 * @param {string}  fieldName       - Property name on the protection object.
 * @param {boolean} expectedEnabled - Expected value of field.enabled.
 * @param {string}  label           - Human-readable label for console output.
 */
function checkField(protection, fieldName, expectedEnabled, label) {
  const field = protection[fieldName];
  if (field && typeof field === "object" && field.enabled === expectedEnabled) {
    console.log(`  ${label}: PASS`);
    return true;
  }
  if (field && typeof field === "object" && field.enabled === !expectedEnabled) {
    const state = field.enabled ? "enabled" : "disabled";
    console.log(`  ${label}: FAIL (currently ${state})`);
    return false;
  }
  console.log(`  ${label}: FAIL (missing or unexpected value: ${JSON.stringify(field)})`);
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- Token check (fail-closed) ---
  if (!TOKEN) {
    if (ALLOW_SKIP) {
      console.log("Branch protection check skipped: TOKEN not set");
      console.log("\n0 passed, 0 failed, 0 skipped");
      process.exit(0);
    }
    console.log("FAIL: BRANCH_PROTECTION_TOKEN (or GITHUB_TOKEN) is not set.");
    console.log("      Set BRANCH_PROTECTION_TOKEN or pass --allow-skip to skip this check.");
    process.exit(1);
  }

  // Build the repository list from REPOSITORIES (single source of truth).
  const repoEntries = Object.entries(REPOSITORIES).map(([name, cfg]) => ({
    name,
    fullName: `${cfg.owner}/${cfg.repo}`,
    branch: cfg.branch
  }));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const FIELDS = [
    ["allow_force_pushes", false, "force-push disabled"],
    ["allow_deletions", false, "deletion disabled"],
    ["enforce_admins", true, "enforce admins"]
  ];

  for (const entry of repoEntries) {
    const { name, fullName, branch } = entry;
    const displayRef = `${fullName}:${branch}`;
    console.log(`${displayRef} (${name})`);

    // --- API call ---
    let status, body;
    try {
      ({ status, body } = await apiRequest(
        TOKEN,
        `/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`
      ));
    } catch (err) {
      console.log(`  FAIL: Request failed — ${err.message}`);
      failed += FIELDS.length;
      continue;
    }

    // --- 404: branch protection not configured ---
    if (status === 404) {
      if (ALLOW_SKIP) {
        for (const [, , label] of FIELDS) {
          console.log(`  ${label}: SKIP (branch protection not configured)`);
        }
        skipped += FIELDS.length;
      } else {
        console.log("  FAIL: Branch protection is not configured on this branch (HTTP 404).");
        console.log("        Enable branch protection or pass --allow-skip.");
        failed += FIELDS.length;
      }
      continue;
    }

    // --- Unexpected HTTP status ---
    if (status !== 200) {
      console.log(`  FAIL: Unexpected HTTP status ${status}`);
      failed += FIELDS.length;
      continue;
    }

    // --- Parse response ---
    let protection;
    try {
      protection = JSON.parse(body);
    } catch (e) {
      console.log(`  FAIL: Failed to parse API response — ${e.message}`);
      failed += FIELDS.length;
      continue;
    }

    // --- Check all three protection fields ---
    for (const [fieldName, expectedEnabled, label] of FIELDS) {
      if (checkField(protection, fieldName, expectedEnabled, label)) {
        passed++;
      } else {
        failed++;
      }
    }
  }

  // --- Summary ---
  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  console.log(`\n${parts.join(", ")}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
