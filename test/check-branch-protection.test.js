import {
  describe,
  expect,
  it
} from "vitest";

import { REPOSITORIES } from "../review-core.js";

// ---------------------------------------------------------------------------
// Pure-logic field check helpers — mirrors scripts/check-branch-protection.js
// but extracted so tests never hit the network or call process.exit().
// ---------------------------------------------------------------------------

/**
 * Returns true when allow_force_pushes is an object with enabled===false.
 * Matches the checkForcePush() logic in scripts/check-branch-protection.js.
 */
function isForcePushDisabled(protection) {
  const fpe = protection.allow_force_pushes;
  return !!(fpe && typeof fpe === "object" && fpe.enabled === false);
}

/**
 * Returns true when allow_deletions is an object with enabled===false.
 * Matches the checkDeletion() logic in scripts/check-branch-protection.js.
 */
function isDeletionDisabled(protection) {
  const ad = protection.allow_deletions;
  return !!(ad && typeof ad === "object" && ad.enabled === false);
}

/**
 * Returns true when enforce_admins is an object with enabled===true.
 * This is a recommended additional check — the current BP script only
 * validates force_push and deletion, but enforce_admins is a logical
 * third pillar of branch protection.
 */
function isEnforceAdminsEnabled(protection) {
  const ea = protection.enforce_admins;
  return !!(ea && typeof ea === "object" && ea.enabled === true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("check-branch-protection", () => {

  // --- REPOSITORIES structure ---

  describe("REPOSITORIES structure", () => {

    it("has exactly 2 repositories", () => {
      const names = Object.keys(REPOSITORIES);
      expect(names).toHaveLength(2);
      expect(names).toContain("xinbaijin");
      expect(names).toContain("xinbaijin-mcp");
    });

    it("all repos have required config fields (owner, repo, branch)", () => {
      for (const [name, cfg] of Object.entries(REPOSITORIES)) {
        expect(cfg.owner, `${name}: owner is required`).toBeTruthy();
        expect(typeof cfg.owner, `${name}: owner is a string`).toBe("string");

        expect(cfg.repo, `${name}: repo is required`).toBeTruthy();
        expect(typeof cfg.repo, `${name}: repo is a string`).toBe("string");

        expect(cfg.branch, `${name}: branch is required`).toBeTruthy();
        expect(cfg.branch, `${name}: branch is "dev"`).toBe("dev");
      }
    });

    it("REPOSITORIES is frozen (immutable)", () => {
      expect(Object.isFrozen(REPOSITORIES)).toBe(true);
    });
  });

  // --- Force-push field checks ---

  describe("allow_force_pushes field check", () => {

    it("passes when allow_force_pushes.enabled is false", () => {
      const protection = { allow_force_pushes: { enabled: false } };
      expect(protection.allow_force_pushes.enabled).toBe(false);
      expect(isForcePushDisabled(protection)).toBe(true);
    });

    it("fails when allow_force_pushes.enabled is true", () => {
      const protection = { allow_force_pushes: { enabled: true } };
      expect(protection.allow_force_pushes.enabled).not.toBe(false);
      expect(isForcePushDisabled(protection)).toBe(false);
    });

    it("fails when allow_force_pushes is missing from response", () => {
      const protection = {};
      expect(isForcePushDisabled(protection)).toBe(false);
    });

    it("fails when allow_force_pushes is null", () => {
      const protection = { allow_force_pushes: null };
      expect(isForcePushDisabled(protection)).toBe(false);
    });

    it("fails when allow_force_pushes is undefined", () => {
      const protection = { allow_force_pushes: undefined };
      expect(isForcePushDisabled(protection)).toBe(false);
    });

    it("fails when allow_force_pushes is a non-object (e.g. boolean)", () => {
      const protection = { allow_force_pushes: false };
      expect(isForcePushDisabled(protection)).toBe(false);
    });

    it("fails when allow_force_pushes has no .enabled property", () => {
      const protection = { allow_force_pushes: {} };
      expect(isForcePushDisabled(protection)).toBe(false);
    });
  });

  // --- Deletion field checks ---

  describe("allow_deletions field check", () => {

    it("passes when allow_deletions.enabled is false", () => {
      const protection = { allow_deletions: { enabled: false } };
      expect(protection.allow_deletions.enabled).toBe(false);
      expect(isDeletionDisabled(protection)).toBe(true);
    });

    it("fails when allow_deletions.enabled is true", () => {
      const protection = { allow_deletions: { enabled: true } };
      expect(protection.allow_deletions.enabled).not.toBe(false);
      expect(isDeletionDisabled(protection)).toBe(false);
    });

    it("fails when allow_deletions is missing from response", () => {
      const protection = {};
      expect(isDeletionDisabled(protection)).toBe(false);
    });

    it("fails when allow_deletions is null", () => {
      const protection = { allow_deletions: null };
      expect(isDeletionDisabled(protection)).toBe(false);
    });

    it("fails when allow_deletions is undefined", () => {
      const protection = { allow_deletions: undefined };
      expect(isDeletionDisabled(protection)).toBe(false);
    });

    it("fails when allow_deletions is a non-object (e.g. boolean)", () => {
      const protection = { allow_deletions: false };
      expect(isDeletionDisabled(protection)).toBe(false);
    });

    it("fails when allow_deletions has no .enabled property", () => {
      const protection = { allow_deletions: {} };
      expect(isDeletionDisabled(protection)).toBe(false);
    });
  });

  // --- Enforce-admins field checks (recommended additional check) ---

  describe("enforce_admins field check", () => {

    it("passes when enforce_admins.enabled is true", () => {
      const protection = { enforce_admins: { enabled: true } };
      expect(protection.enforce_admins.enabled).toBe(true);
      expect(isEnforceAdminsEnabled(protection)).toBe(true);
    });

    it("fails when enforce_admins.enabled is false", () => {
      const protection = { enforce_admins: { enabled: false } };
      expect(protection.enforce_admins.enabled).not.toBe(true);
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("fails when enforce_admins is missing from response", () => {
      const protection = {};
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("fails when enforce_admins is null", () => {
      const protection = { enforce_admins: null };
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("fails when enforce_admins is undefined", () => {
      const protection = { enforce_admins: undefined };
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("fails when enforce_admins is a non-object (e.g. boolean)", () => {
      const protection = { enforce_admins: true };
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("fails when enforce_admins has no .enabled property", () => {
      const protection = { enforce_admins: {} };
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });
  });

  // --- Combined checks (complete protection response) ---

  describe("combined protection checks", () => {

    it("complete valid protection response passes all 3 checks", () => {
      const protection = {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true }
      };

      const checks = [
        {
          field: "allow_force_pushes",
          expected: false,
          ok: protection.allow_force_pushes?.enabled === false
        },
        {
          field: "allow_deletions",
          expected: false,
          ok: protection.allow_deletions?.enabled === false
        },
        {
          field: "enforce_admins",
          expected: true,
          ok: protection.enforce_admins?.enabled === true
        }
      ];

      expect(checks.filter(c => c.ok).length).toBe(3);
      expect(checks.filter(c => !c.ok).length).toBe(0);

      // Also via helper functions
      expect(isForcePushDisabled(protection)).toBe(true);
      expect(isDeletionDisabled(protection)).toBe(true);
      expect(isEnforceAdminsEnabled(protection)).toBe(true);
    });

    it("all 3 fail with an empty response", () => {
      const protection = {};

      const checks = [
        { field: "allow_force_pushes", ok: isForcePushDisabled(protection) },
        { field: "allow_deletions", ok: isDeletionDisabled(protection) },
        { field: "enforce_admins", ok: isEnforceAdminsEnabled(protection) }
      ];

      expect(checks.filter(c => c.ok).length).toBe(0);
      expect(checks.filter(c => !c.ok).length).toBe(3);
    });

    it("only allow_force_pushes enabled → fails force-push, passes others", () => {
      const protection = {
        allow_force_pushes: { enabled: true },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true }
      };

      expect(isForcePushDisabled(protection)).toBe(false);
      expect(isDeletionDisabled(protection)).toBe(true);
      expect(isEnforceAdminsEnabled(protection)).toBe(true);
    });

    it("only allow_deletions enabled → fails deletion, passes others", () => {
      const protection = {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: true },
        enforce_admins: { enabled: true }
      };

      expect(isForcePushDisabled(protection)).toBe(true);
      expect(isDeletionDisabled(protection)).toBe(false);
      expect(isEnforceAdminsEnabled(protection)).toBe(true);
    });

    it("only enforce_admins disabled → fails admins, passes others", () => {
      const protection = {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: false }
      };

      expect(isForcePushDisabled(protection)).toBe(true);
      expect(isDeletionDisabled(protection)).toBe(true);
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("all three enabled/wrong → all fail", () => {
      const protection = {
        allow_force_pushes: { enabled: true },
        allow_deletions: { enabled: true },
        enforce_admins: { enabled: false }
      };

      expect(isForcePushDisabled(protection)).toBe(false);
      expect(isDeletionDisabled(protection)).toBe(false);
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("all three fields null → all fail", () => {
      const protection = {
        allow_force_pushes: null,
        allow_deletions: null,
        enforce_admins: null
      };

      expect(isForcePushDisabled(protection)).toBe(false);
      expect(isDeletionDisabled(protection)).toBe(false);
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });

    it("all three fields missing (empty object) → all fail", () => {
      const protection = {};

      expect(isForcePushDisabled(protection)).toBe(false);
      expect(isDeletionDisabled(protection)).toBe(false);
      expect(isEnforceAdminsEnabled(protection)).toBe(false);
    });
  });
});
