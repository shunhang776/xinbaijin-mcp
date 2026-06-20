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
 *
 * Without these protections, the re-read + force:false PATCH in
 * updateBranchRefFastForward is not sufficient to guarantee that the
 * review commit always has the expected parent.
 *
 * FAIL-CLOSED DESIGN:
 * Any missing token, API error, unexpected HTTP status, JSON parse failure,
 * missing/unexpected response fields, or protection misconfiguration results
 * in a non-zero exit code. Only explicit enabled===false on BOTH fields for
 * every repository counts as a PASS.
 *
 * Pass --allow-skip to downgrade missing-GITHUB_TOKEN and 404 (branch
 * protection not configured) from FAIL to SKIP. All other failure modes
 * remain hard FAILs regardless of --allow-skip.
 */

import https from "https";
import { REPOSITORIES } from "../review-core.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ALLOW_SKIP = process.argv.includes("--allow-skip");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Perform a GET request against the GitHub REST API.
 * Returns { status, body } where body is the raw response text.
 */
function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method: "GET",
      headers: {
        "User-Agent": "check-branch-protection",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json"
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

// ---------------------------------------------------------------------------
// Field check helpers — each returns true on PASS, false on FAIL
// ---------------------------------------------------------------------------

function checkForcePush(protection) {
  const fpe = protection.allow_force_pushes;
  if (fpe && typeof fpe === "object" && fpe.enabled === false) {
    console.log("  force-push disabled: PASS");
    return true;
  }
  if (fpe && fpe.enabled === true) {
    console.log("  force-push disabled: FAIL (currently enabled)");
    return false;
  }
  console.log(`  force-push disabled: FAIL (missing or unexpected value: ${JSON.stringify(fpe)})`);
  return false;
}

function checkDeletion(protection) {
  const ad = protection.allow_deletions;
  if (ad && typeof ad === "object" && ad.enabled === false) {
    console.log("  deletion disabled:    PASS");
    return true;
  }
  if (ad && ad.enabled === true) {
    console.log("  deletion disabled:    FAIL (currently enabled)");
    return false;
  }
  console.log(`  deletion disabled:    FAIL (missing or unexpected value: ${JSON.stringify(ad)})`);
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- Token check (fail-closed) ---
  if (!GITHUB_TOKEN) {
    if (ALLOW_SKIP) {
      console.log("GITHUB_TOKEN not set. Skipping branch protection check (--allow-skip).");
      console.log("\n0 passed, 0 failed, 0 skipped");
      process.exit(0);
    }
    console.log("FAIL: GITHUB_TOKEN is not set. Branch protection check cannot proceed.");
    console.log("      Set GITHUB_TOKEN or pass --allow-skip to skip this check.");
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

  for (const entry of repoEntries) {
    const { name, fullName, branch } = entry;
    const displayRef = `${fullName}:${branch}`;
    console.log(`${displayRef} (${name})`);

    // --- API call ---
    let status, body;
    try {
      ({ status, body } = await apiRequest(
        `/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`
      ));
    } catch (err) {
      console.log(`  FAIL: Request failed — ${err.message}`);
      failed++;
      continue;
    }

    // --- 404: branch protection not configured ---
    if (status === 404) {
      if (ALLOW_SKIP) {
        console.log("  force-push disabled: SKIP (branch protection not configured)");
        console.log("  deletion disabled:    SKIP (branch protection not configured)");
        skipped++;
      } else {
        console.log("  FAIL: Branch protection is not configured on this branch (HTTP 404).");
        console.log("        Enable branch protection or pass --allow-skip.");
        failed++;
      }
      continue;
    }

    // --- Unexpected HTTP status ---
    if (status !== 200) {
      console.log(`  FAIL: Unexpected HTTP status ${status}`);
      failed++;
      continue;
    }

    // --- Parse response ---
    let protection;
    try {
      protection = JSON.parse(body);
    } catch (e) {
      console.log(`  FAIL: Failed to parse API response — ${e.message}`);
      failed++;
      continue;
    }

    // --- Check both protection fields ---
    const fpeOk = checkForcePush(protection);
    const adOk = checkDeletion(protection);

    if (fpeOk && adOk) {
      passed++;
    } else {
      failed++;
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
