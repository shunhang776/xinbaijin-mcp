[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$ExpectedRepository = "shunhang776/xinbaijin-mcp",
    [string]$Branch = "dev",
    [string]$OutputDir = "",
    [switch]$NoFetch
)

Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    )
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RepoRoot ".baijin" "repair-bridge"
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# ---------------------------------------------------------------------------
# Repair Bridge — review.json merge → Claude Code handoff
# =========================================================
#
# Reads review.json from the current checkout (post-merge to dev),
# dispatches by verdict:
#
#   approved           → write approved artifact, no handoff
#   blocked            → write manual_required artifact
#   changes_requested  → call repair-validate → repair-run Prepare
#                         → repair-prompt → collect artifacts
#                         → write claude-repair-handoff.json
#
# This script does NOT:
#   - modify source code
#   - modify review.json
#   - push to dev
#   - create PRs
#   - auto-merge
#   - auto-deploy
#
# Protocol: baijin-repair-bridge/1.0
# ---------------------------------------------------------------------------

$ReviewJsonPath = Join-Path $RepoRoot "review.json"
$RepairValidateScript = Join-Path $PSScriptRoot "repair-validate.ps1"
$RepairRunScript = Join-Path $PSScriptRoot "repair-run.ps1"
$RepairPromptScript = Join-Path $PSScriptRoot "repair-prompt.ps1"

# ── Helpers ────────────────────────────────────────────────────────────────

function Write-BridgeOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,
        [Parameter(Mandatory = $true)]
        [hashtable]$Data,
        [string]$Description = ""
    )

    $outPath = Join-Path $OutputDir $FileName
    $json = $Data | ConvertTo-Json -Depth 10 -Compress
    $json | Set-Content -Path $outPath -Encoding utf8

    if ($Description) {
        Write-Host "bridge: wrote $FileName — $Description"
    } else {
        Write-Host "bridge: wrote $FileName"
    }
}

# ── Main ───────────────────────────────────────────────────────────────────

Write-Host "=== Repair Bridge ==="
Write-Host "RepoRoot: $RepoRoot"
Write-Host "OutputDir: $OutputDir"

# 1. Read review.json
if (-not (Test-Path $ReviewJsonPath)) {
    Write-Host "bridge: review.json not found at $ReviewJsonPath — nothing to bridge"
    Write-BridgeOutput -FileName "bridge-status.json" -Data @{
        protocol = "baijin-repair-bridge/1.0"
        status = "skipped"
        reason = "review.json not found"
        timestamp = (Get-Date -Format "o")
    } -Description "no review.json"
    exit 0
}

$reviewText = Get-Content -Path $ReviewJsonPath -Raw -Encoding utf8
$review = $reviewText | ConvertFrom-Json

if (-not $review) {
    Write-Host "bridge: failed to parse review.json"
    exit 1
}

$verdict = $review.verdict
$reviewedCommit = $review.reviewed_commit
$basedOnBranchHead = $review.based_on_branch_head
$findingsCount = if ($review.findings) { $review.findings.Count } else { 0 }

Write-Host "bridge: verdict=$verdict reviewed_commit=$($reviewedCommit.Substring(0,7)) findings=$findingsCount"

# 2. Determine repair round
$roundPath = Join-Path $OutputDir "repair-round.txt"
$repairRound = 1
if (Test-Path $roundPath) {
    $existing = (Get-Content -Path $roundPath -Raw -Encoding utf8).Trim()
    if ($existing -match '^\d+$') {
        $repairRound = [int]$existing + 1
    }
}

# 3. Dispatch by verdict
switch ($verdict) {
    "approved" {
        Write-Host "bridge: verdict=approved — writing approved artifact, no repair handoff"

        Write-BridgeOutput -FileName "claude-repair-handoff.json" -Data @{
            protocol = "baijin-repair-bridge/1.0"
            status = "approved"
            repository = $review.repository
            branch = $review.branch
            reviewed_commit = $reviewedCommit
            based_on_branch_head = $basedOnBranchHead
            source_review_commit = $reviewedCommit
            verdict = "approved"
            findings = @()
            repair_round = 0
            next_action = "none"
            message = "Review approved. No repair needed."
            generated_at = (Get-Date -Format "o")
        } -Description "approved handoff"

        $repairRound | Set-Content -Path $roundPath -Encoding utf8 -NoNewline
        exit 0
    }

    "blocked" {
        Write-Host "bridge: verdict=blocked — writing manual_required artifact"

        Write-BridgeOutput -FileName "claude-repair-handoff.json" -Data @{
            protocol = "baijin-repair-bridge/1.0"
            status = "manual_required"
            repository = $review.repository
            branch = $review.branch
            reviewed_commit = $reviewedCommit
            based_on_branch_head = $basedOnBranchHead
            source_review_commit = $reviewedCommit
            verdict = "blocked"
            findings = $review.findings
            repair_round = 0
            next_action = "manual_required"
            message = "Review blocked by ChatGPT. Manual intervention required."
            generated_at = (Get-Date -Format "o")
        } -Description "blocked — manual required"

        $repairRound | Set-Content -Path $roundPath -Encoding utf8 -NoNewline
        exit 0
    }

    "changes_requested" {
        Write-Host "bridge: verdict=changes_requested — generating repair handoff (round $repairRound)"

        # 3a. Run repair-validate (best-effort; captured into handoff)
        Write-Host "bridge: running repair-validate..."
        $validateArgs = @(
            "-RepoRoot", $RepoRoot,
            "-ExpectedRepository", $ExpectedRepository,
            "-Branch", $Branch
        )
        if ($NoFetch) {
            $validateArgs += "-NoFetch"
        }

        $validateResult = @()
        $validateExit = 0
        try {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $validateResult = & $RepairValidateScript @validateArgs 2>&1
            $validateExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
        } catch {
            $validateExit = 1
            $validateResult = @("repair-validate threw: $_")
        }

        Write-Host "bridge: repair-validate exit=$validateExit"
        if ($validateResult) {
            $validateResult | ForEach-Object { Write-Host "  validate: $_" }
        }

        # 3b. Run repair-run Prepare (best-effort)
        Write-Host "bridge: running repair-run -Mode Prepare..."
        $prepareArgs = @(
            "-Mode", "Prepare",
            "-RepoRoot", $RepoRoot,
            "-Branch", $Branch,
            "-ReviewedCommit", $reviewedCommit
        )
        if ($NoFetch) {
            $prepareArgs += "-NoFetch"
        }

        $prepareResult = @()
        $prepareExit = 0
        try {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $prepareResult = & $RepairRunScript @prepareArgs 2>&1
            $prepareExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
        } catch {
            $prepareExit = 1
            $prepareResult = @("repair-run threw: $_")
        }

        Write-Host "bridge: repair-run Prepare exit=$prepareExit"
        if ($prepareResult) {
            $prepareResult | ForEach-Object { Write-Host "  prepare: $_" }
        }

        # 3c. Run repair-prompt (best-effort)
        Write-Host "bridge: running repair-prompt..."
        $promptOutputPath = Join-Path $OutputDir "repair-prompt.md"
        $promptContextPath = Join-Path $OutputDir "repair-context.json"

        $promptArgs = @(
            "-RepoRoot", $RepoRoot,
            "-OutputPath", $promptOutputPath,
            "-ContextPath", $promptContextPath
        )
        if ($reviewedCommit) {
            $promptArgs += @("-ReviewedCommit", $reviewedCommit)
        }

        $promptResult = @()
        $promptExit = 0
        try {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $promptResult = & $RepairPromptScript @promptArgs 2>&1
            $promptExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
        } catch {
            $promptExit = 1
            $promptResult = @("repair-prompt threw: $_")
        }

        Write-Host "bridge: repair-prompt exit=$promptExit"
        if ($promptResult) {
            $promptResult | ForEach-Object { Write-Host "  prompt: $_" }
        }

        # 3d. Collect findings and allowed files from repair-run output
        $findings = if ($review.findings) {
            @($review.findings | ForEach-Object {
                [PSCustomObject]@{
                    severity = $_.severity
                    file = $_.file
                    line = $_.line
                    title = $_.title
                    description = $_.description
                    recommendation = $_.recommendation
                }
            })
        } else {
            @()
        }

        # 3e. Write claude-repair-handoff.json
        Write-BridgeOutput -FileName "claude-repair-handoff.json" -Data @{
            protocol = "baijin-repair-bridge/1.0"
            status = "repair_needed"
            repository = $review.repository
            branch = $review.branch
            reviewed_commit = $reviewedCommit
            based_on_branch_head = $basedOnBranchHead
            source_review_commit = $reviewedCommit
            verdict = "changes_requested"
            repair_round = $repairRound
            findings = $findings
            findings_count = $findingsCount
            next_action = "claude_code_repair"
            repair_prompt_path = $promptOutputPath
            repair_context_path = $promptContextPath
            message = "Repair needed. Use repair-prompt.md and repair-context.json as Claude Code input."
            generated_at = (Get-Date -Format "o")
            repair_validate_exit = $validateExit
            repair_prepare_exit = $prepareExit
            repair_prompt_exit = $promptExit
        } -Description "changes_requested — repair handoff for Claude Code"

        $repairRound | Set-Content -Path $roundPath -Encoding utf8 -NoNewline

        Write-Host "bridge: repair handoff complete (round $repairRound)"
        exit 0
    }

    default {
        Write-Host "bridge: unknown verdict '$verdict'"
        Write-BridgeOutput -FileName "bridge-status.json" -Data @{
            protocol = "baijin-repair-bridge/1.0"
            status = "error"
            reason = "unknown verdict: $verdict"
            timestamp = (Get-Date -Format "o")
        } -Description "unknown verdict"
        exit 1
    }
}
