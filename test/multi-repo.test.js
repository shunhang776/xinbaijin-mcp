import {
  REPOSITORIES,
  DEFAULT_REPOSITORY,
  getRepositoryConfig
} from "../review-core.js";

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertThrows(fn, expectedMessage, label) {
  try {
    fn();
    failed++;
    console.error(`FAIL: ${label} — no error was thrown`);
  } catch (err) {
    if (err.message && err.message.includes(expectedMessage)) {
      passed++;
    } else {
      failed++;
      console.error(
        `FAIL: ${label} — expected message containing "${expectedMessage}", got "${err.message}"`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1 — No repository defaults to xinbaijin
// ---------------------------------------------------------------------------
{
  const env = { GITHUB_TOKEN: "ghp_test123" };
  const config = getRepositoryConfig(env);
  assertEqual(config.owner, "shunhang776", "1a: default owner");
  assertEqual(config.repo, "xinbaijin", "1b: default repo");
  assertEqual(config.branch, "dev", "1c: default branch");
  assertEqual(config.token, "ghp_test123", "1d: token passes through");
}

// ---------------------------------------------------------------------------
// Test 2 — Explicit xinbaijin-mcp resolves correctly
// ---------------------------------------------------------------------------
{
  const env = { GITHUB_TOKEN: "ghp_mcp" };
  const config = getRepositoryConfig(env, "xinbaijin-mcp");
  assertEqual(config.owner, "shunhang776", "2a: mcp owner");
  assertEqual(config.repo, "xinbaijin-mcp", "2b: mcp repo");
  assertEqual(config.branch, "dev", "2c: mcp branch");
  assertEqual(config.token, "ghp_mcp", "2d: mcp token");
}

// ---------------------------------------------------------------------------
// Test 3 — Non-whitelist repo throws
// ---------------------------------------------------------------------------
{
  assertThrows(
    () => getRepositoryConfig({ GITHUB_TOKEN: "t" }, "evil-repo"),
    "Unknown repository",
    "3: unknown repo throws"
  );
}

// ---------------------------------------------------------------------------
// Test 4 — REPOSITORIES has exactly 2 keys, same owner
// ---------------------------------------------------------------------------
{
  const keys = Object.keys(REPOSITORIES);
  assertEqual(keys.length, 2, "4a: exactly 2 keys");
  assert(
    keys.includes("xinbaijin") && keys.includes("xinbaijin-mcp"),
    "4b: keys are xinbaijin and xinbaijin-mcp"
  );
  const owners = new Set(keys.map((k) => REPOSITORIES[k].owner));
  assert(
    owners.size === 1 && owners.has("shunhang776"),
    "4c: both repos share the same owner"
  );
}

// ---------------------------------------------------------------------------
// Test 5 — Two repos return different repo values; same repo is consistent
// ---------------------------------------------------------------------------
{
  const env = {};
  const cfg1 = getRepositoryConfig(env, "xinbaijin");
  const cfg2 = getRepositoryConfig(env, "xinbaijin-mcp");
  assert(
    cfg1.repo !== cfg2.repo,
    "5a: two repos return different repo values"
  );
  const cfg1b = getRepositoryConfig(env, "xinbaijin");
  assertEqual(cfg1.repo, cfg1b.repo, "5b: same repo returns consistent config (repo)");
  assertEqual(cfg1.owner, cfg1b.owner, "5c: same repo returns consistent config (owner)");
  assertEqual(cfg1.branch, cfg1b.branch, "5d: same repo returns consistent config (branch)");
}

// ---------------------------------------------------------------------------
// Test 6 — Token passes through from env; missing token yields undefined
// ---------------------------------------------------------------------------
{
  const configWith = getRepositoryConfig({ GITHUB_TOKEN: "present" });
  assertEqual(configWith.token, "present", "6a: token passes through from env");

  const configWithout = getRepositoryConfig({});
  assert(
    configWithout.token === undefined,
    "6b: missing GITHUB_TOKEN is undefined, no crash"
  );
  // Verify the rest of the config is still intact.
  assertEqual(configWithout.owner, "shunhang776", "6c: owner still set when token missing");
  assertEqual(configWithout.repo, "xinbaijin", "6d: repo still set when token missing");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
}
