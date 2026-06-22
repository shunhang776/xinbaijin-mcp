import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("scripts", "repair-run.ps1"),
  "utf8"
);

describe("repair-run PowerShell compatibility", () => {
  it("forwards Branch and NoFetch to repair-validate", () => {
    expect(source).toContain("[switch]$NoFetch");
    expect(source).toMatch(/"-Branch",\s*\$Branch/s);
    expect(source).toMatch(
      /if \(\$NoFetch\)\s*\{\s*\$validatorArguments \+= "-NoFetch"/s
    );
  });

  it("forwards the selected branch as the prompt RemoteRef", () => {
    expect(source).toMatch(
      /"-RemoteRef",\s*\("origin\/\{0\}" -f \$Branch\)/s
    );
  });

  it("allows an empty ExtraPatterns collection on Windows PowerShell 5.1", () => {
    expect(source).toMatch(
      /\[AllowEmptyCollection\(\)\]\s*\[string\[\]\]\$ExtraPatterns/s
    );
  });

  it("converts generic lists before writing the final JSON result", () => {
    expect(source).toContain("$gates.ToArray()");
    expect(source).toContain("$unexpectedPaths.ToArray()");
    expect(source).not.toContain("@($gates)");
    expect(source).not.toContain("@($unexpectedPaths)");
  });
});
