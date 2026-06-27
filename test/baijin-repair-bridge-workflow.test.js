import {
  describe,
  expect,
  it
} from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(
  fileURLToPath(import.meta.url)
);
const workflowPath = resolve(
  __dirname,
  "../.github/workflows/baijin-repair-bridge.yml"
);
const yaml = readFileSync(
  workflowPath,
  "utf-8"
);

describe(
  "baijin-repair-bridge.yml — trigger and permissions",
  () => {
    it("triggers on push to dev", () => {
      expect(yaml).toContain(
        "push:"
      );
      expect(yaml).toContain(
        "- dev"
      );
    });

    it("only triggers when review.json changes", () => {
      expect(yaml).toContain(
        "paths:"
      );
      expect(yaml).toContain(
        "review.json"
      );
    });

    it("has read-only contents permission", () => {
      expect(yaml).toContain(
        "contents: read"
      );
      // Should NOT have contents: write
      expect(yaml).not.toMatch(
        /contents:\s*write/
      );
    });

    it("does not have pull-requests write permission", () => {
      expect(yaml).not.toMatch(
        /pull-requests:\s*write/
      );
    });

    it("does not have actions write permission", () => {
      expect(yaml).not.toMatch(
        /actions:\s*write/
      );
    });

    it("does not have deployments permission", () => {
      expect(yaml).not.toContain(
        "deployments"
      );
    });
  }
);

describe(
  "baijin-repair-bridge.yml — job configuration",
  () => {
    it("uses windows-latest runner", () => {
      expect(yaml).toContain(
        "windows-latest"
      );
    });

    it("has a reasonable timeout", () => {
      expect(yaml).toContain(
        "timeout-minutes: 10"
      );
    });

    it("runs repair-bridge.ps1", () => {
      expect(yaml).toContain(
        "repair-bridge.ps1"
      );
    });

    it("passes RepoRoot and ExpectedRepository", () => {
      expect(yaml).toContain(
        "RepoRoot"
      );
      expect(yaml).toContain(
        "ExpectedRepository"
      );
      expect(yaml).toContain(
        "github.repository"
      );
    });

    it("uploads repair artifacts", () => {
      expect(yaml).toContain(
        "upload-artifact"
      );
      expect(yaml).toContain(
        "repair-bridge-output"
      );
      expect(yaml).toContain(
        ".baijin/repair-bridge/"
      );
    });

    it("uploads even on failure (if: always)", () => {
      expect(yaml).toMatch(
        /if:\s*always\(\)/
      );
    });
  }
);

describe(
  "baijin-repair-bridge.yml — safety constraints",
  () => {
    it("does not run wrangler deploy", () => {
      expect(yaml).not.toContain(
        "wrangler"
      );
    });

    it("does not push to any branch", () => {
      expect(yaml).not.toMatch(
        /git\s+push/
      );
    });

    it("does not use gh pr merge", () => {
      expect(yaml).not.toContain(
        "gh pr merge"
      );
    });

    it("does not use gh pr create", () => {
      expect(yaml).not.toContain(
        "gh pr create"
      );
    });

    it("does not modify review.json", () => {
      // No step should write to review.json
      expect(yaml).not.toMatch(
        /Set-Content.*review\.json/
      );
      expect(yaml).not.toMatch(
        /Out-File.*review\.json/
      );
      expect(yaml).not.toMatch(
        /git add.*review\.json/
      );
    });

    it("does not require self-hosted runner", () => {
      expect(yaml).not.toContain(
        "self-hosted"
      );
    });

    it("does not have secret write access", () => {
      expect(yaml).not.toContain(
        "secrets: write"
      );
    });
  }
);

describe(
  "baijin-repair-bridge.yml — artifact retention",
  () => {
    it("sets reasonable retention period", () => {
      expect(yaml).toContain(
        "retention-days"
      );
    });

    it("artifacts expire (not permanent)", () => {
      const retention =
        yaml.match(
          /retention-days:\s*(\d+)/
        );
      expect(retention).not
        .toBeNull();
      const days = parseInt(
        retention[1],
        10
      );
      expect(days).toBeLessThan(
        30
      );
      expect(days).toBeGreaterThan(
        0
      );
    });
  }
);
