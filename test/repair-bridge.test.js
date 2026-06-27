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
const scriptPath = resolve(
  __dirname,
  "../scripts/repair-bridge.ps1"
);
const src = readFileSync(
  scriptPath,
  "utf-8"
);

describe(
  "repair-bridge.ps1 — verdict dispatch",
  () => {
    it("handles verdict=approved", () => {
      expect(
        src
      ).toMatch(/"approved"\s*\{/);
      expect(src).toContain(
        "verdict=approved"
      );
      expect(src).toContain(
        "No repair needed"
      );
      expect(src).toContain(
        'status = "approved"'
      );
    });

    it("handles verdict=blocked", () => {
      expect(
        src
      ).toMatch(/"blocked"\s*\{/);
      expect(src).toContain(
        "verdict=blocked"
      );
      expect(src).toContain(
        "manual_required"
      );
      expect(src).toContain(
        'status = "manual_required"'
      );
      expect(src).toContain(
        "Manual intervention required"
      );
    });

    it("handles verdict=changes_requested", () => {
      expect(
        src
      ).toMatch(
        /"changes_requested"\s*\{/
      );
      expect(src).toContain(
        "repair-validate"
      );
      expect(src).toContain(
        "repair-run"
      );
      expect(src).toContain(
        "repair-prompt"
      );
      expect(src).toContain(
        'status = "repair_needed"'
      );
      expect(src).toContain(
        "repair_round"
      );
    });

    it("handles unknown verdict as error", () => {
      expect(
        src
      ).toMatch(/default\s*\{/);
      expect(src).toContain(
        "unknown verdict"
      );
      expect(src).toContain(
        'status = "error"'
      );
    });

    it("reads review.json from RepoRoot", () => {
      expect(src).toContain(
        "review.json"
      );
      expect(src).toContain(
        '$ReviewJsonPath = Join-Path $RepoRoot "review.json"'
      );
    });

    it("parses verdict from review.json", () => {
      expect(src).toContain(
        "$verdict = $review.verdict"
      );
      expect(src).toContain(
        "$reviewedCommit = $review.reviewed_commit"
      );
      expect(src).toContain(
        "$basedOnBranchHead = $review.based_on_branch_head"
      );
    });
  }
);

describe(
  "repair-bridge.ps1 — does NOT modify source or push",
  () => {
    it("does not git push to dev", () => {
      // Should not contain any git push command
      const pushPatterns = [
        /git\s+push/,
        /Push-Location/,
        /git\s+merge/,
        /gh\s+pr\s+merge/
      ];

      for (const pattern of pushPatterns) {
        expect(src).not.toMatch(
          pattern
        );
      }
    });

    it("does not modify source files", () => {
      const modifyPatterns = [
        /Set-Content.*\.js/,
        /Out-File.*\.js/,
        /git\s+add\s+(?!.*review\.json)/,
        /git\s+commit/
      ];

      for (const pattern of modifyPatterns) {
        expect(src).not.toMatch(
          pattern
        );
      }
    });

    it("does not auto-merge or auto-deploy", () => {
      expect(src).not.toMatch(
        /gh\s+pr\s+merge/
      );
      expect(src).not.toMatch(
        /wrangler\s+deploy/
      );
      expect(src).not.toMatch(
        /npm\s+run\s+deploy/
      );
    });

    it("writes only to .baijin/repair-bridge/ output dir", () => {
      // All Set-Content / Out-File calls should target $OutputDir
      const writeLines = src
        .split("\n")
        .filter(
          (l) =>
            l.includes(
              "Set-Content"
            ) ||
            l.includes("Out-File")
        );

      for (const line of writeLines) {
        expect(line).toMatch(
          /\$OutputDir|\$outPath|\$roundPath|\$promptOutputPath|\$promptContextPath/
        );
      }
    });
  }
);

describe(
  "repair-bridge.ps1 — artifact generation",
  () => {
    it("generates claude-repair-handoff.json for all verdicts", () => {
      expect(src).toContain(
        "claude-repair-handoff.json"
      );

      // Must appear in all three dispatch branches
      const handoffOccurrences =
        src.match(
          /claude-repair-handoff\.json/g
        ) || [];
      expect(
        handoffOccurrences.length
      ).toBeGreaterThanOrEqual(3);
    });

    it("includes protocol field in all outputs", () => {
      expect(src).toContain(
        'protocol = "baijin-repair-bridge/1.0"'
      );
    });

    it("includes reviewed_commit in all handoffs", () => {
      expect(src).toContain(
        "reviewed_commit"
      );
    });

    it("includes based_on_branch_head in all handoffs", () => {
      expect(src).toContain(
        "based_on_branch_head"
      );
    });

    it("includes source_review_commit in all handoffs", () => {
      expect(src).toContain(
        "source_review_commit"
      );
    });

    it("includes findings in approved/blocked/changes_requested", () => {
      const findingsRefs =
        src.match(/findings/g) || [];
      expect(
        findingsRefs.length
      ).toBeGreaterThanOrEqual(5);
    });

    it("includes repair_round and increments it", () => {
      expect(src).toContain(
        "repair-round.txt"
      );
      expect(src).toContain(
        "$repairRound = 1"
      );
      expect(src).toContain(
        "$repairRound = [int]$existing + 1"
      );
    });

    it("writes generated_at ISO timestamp", () => {
      expect(src).toContain(
        "generated_at"
      );
      expect(src).toContain(
        "Get-Date -Format"
      );
    });
  }
);

describe(
  "repair-bridge.ps1 — edge cases",
  () => {
    it("handles missing review.json gracefully", () => {
      expect(src).toContain(
        "review.json not found"
      );
      expect(src).toContain(
        'status = "skipped"'
      );
      expect(src).toMatch(
        /exit 0/
      );
    });

    it("handles missing findings field", () => {
      expect(src).toContain(
        "$review.findings"
      );
      expect(src).toContain(
        "$findingsCount"
      );
      expect(src).toMatch(
        /\$review\.findings\b.*\bCount/
      );
    });

    it("creates output directory if missing", () => {
      expect(src).toContain(
        "New-Item -ItemType Directory"
      );
      expect(src).toContain(
        "-Force"
      );
    });

    it("supports -NoFetch switch passthrough", () => {
      expect(
        src
      ).toContain("-NoFetch");
    });

    it("exits with code 0 on success paths", () => {
      const exitZeros =
        src.match(/exit 0/g) || [];
      // approved, blocked, changes_requested, missing review.json
      expect(
        exitZeros.length
      ).toBeGreaterThanOrEqual(3);
    });
  }
);

describe(
  "repair-bridge.ps1 — reuses existing repair scripts",
  () => {
    it("calls repair-validate.ps1", () => {
      expect(src).toContain(
        "repair-validate.ps1"
      );
      expect(src).toContain(
        "$RepairValidateScript"
      );
    });

    it("calls repair-run.ps1 -Mode Prepare", () => {
      expect(src).toContain(
        "repair-run.ps1"
      );
      expect(src).toContain(
        '-Mode", "Prepare"'
      );
      expect(src).toContain(
        "$RepairRunScript"
      );
    });

    it("calls repair-prompt.ps1", () => {
      expect(src).toContain(
        "repair-prompt.ps1"
      );
      expect(src).toContain(
        "$RepairPromptScript"
      );
    });

    it("reuses baijin-repair-bridge/1.0 protocol", () => {
      expect(src).toContain(
        "baijin-repair-bridge/1.0"
      );
    });

    it("does not define any new repair protocol", () => {
      const protocols =
        src.match(
          /baijin-[a-z-]+\/\d+\.\d+/g
        ) || [];

      for (const p of protocols) {
        expect(p).toMatch(
          /baijin-repair-(bridge|check|run|prompt|context|submit)\/\d+\.\d+/
        );
      }
    });
  }
);
