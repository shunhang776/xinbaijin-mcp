[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$ExpectedRepository = "shunhang776/xinbaijin-mcp",
    [string]$Branch = "dev",
    [switch]$NoFetch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    )
}

function Convert-ToLines {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return @()
    }

    return @(
        $Text -split "\r?\n" |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($_)
            }
    )
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [switch]$AllowFailure
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $gitCommand = Get-Command git.exe -ErrorAction Stop

        $process = Start-Process `
            -FilePath $gitCommand.Source `
            -WorkingDirectory $RepoRoot `
            -ArgumentList $Arguments `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        $exitCode = $process.ExitCode

        $stdout = if (Test-Path $stdoutPath) {
            [System.IO.File]::ReadAllText($stdoutPath)
        }
        else {
            ""
        }

        $stderr = if (Test-Path $stderrPath) {
            [System.IO.File]::ReadAllText($stderrPath)
        }
        else {
            ""
        }
    }
    finally {
        Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
    }

    $stdoutLines = @(Convert-ToLines -Text $stdout)
    $stderrLines = @(Convert-ToLines -Text $stderr)

    if (-not $AllowFailure -and $exitCode -ne 0) {
        $details = @($stdoutLines + $stderrLines) -join "`n"

        throw (
            "Git command failed: git {0}`n{1}" -f
            ($Arguments -join " "),
            $details
        )
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $stdoutLines
        Error    = $stderrLines
    }
}

function Write-ValidationResult {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [string]$Reason,

        [AllowNull()]
        [object]$Review = $null,

        [AllowNull()]
        [string]$ReviewCommit = $null,

        [AllowNull()]
        [string]$BranchHead = $null,

        [AllowNull()]
        [string]$CurrentCodeHead = $null
    )

    $reviewedCommit = $null
    $verdict = $null
    $findingCount = 0

    if ($null -ne $Review) {
        if ($Review.PSObject.Properties.Name -contains "reviewed_commit") {
            $reviewedCommit = [string]$Review.reviewed_commit
        }

        if ($Review.PSObject.Properties.Name -contains "verdict") {
            $verdict = [string]$Review.verdict
        }

        if ($Review.PSObject.Properties.Name -contains "findings") {
            $findingCount = @($Review.findings).Count
        }
    }

    [ordered]@{
        protocol          = "baijin-repair-check/1.0"
        status            = $Status
        reason            = $Reason
        repository        = $ExpectedRepository
        branch            = $Branch
        branch_head       = $BranchHead
        current_code_head = $CurrentCodeHead
        review_commit     = $ReviewCommit
        reviewed_commit   = $reviewedCommit
        verdict           = $verdict
        finding_count     = $findingCount
        checked_at        = [DateTimeOffset]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 8
}

try {
    $insideWorkTree = Invoke-Git `
        -Arguments @("rev-parse", "--is-inside-work-tree") `
        -AllowFailure

    if (
        $insideWorkTree.ExitCode -ne 0 -or
        $insideWorkTree.Output.Count -eq 0 -or
        $insideWorkTree.Output[0].Trim() -ne "true"
    ) {
        Write-ValidationResult `
            -Status "BLOCKED_INVALID_REPOSITORY" `
            -Reason "RepoRoot is not a Git working tree."

        return
    }

    if (-not $NoFetch) {
        Invoke-Git -Arguments @(
            "fetch",
            "--prune",
            "origin",
            $Branch
        ) | Out-Null
    }

    $remoteRef = "origin/$Branch"

    $branchHeadResult = Invoke-Git -Arguments @(
        "rev-parse",
        $remoteRef
    )

    if ($branchHeadResult.Output.Count -eq 0) {
        throw "Unable to resolve $remoteRef."
    }

    $branchHead = $branchHeadResult.Output[0].Trim()
    $reviewSpec = "{0}:review.json" -f $remoteRef

    $reviewResult = Invoke-Git `
        -Arguments @("show", $reviewSpec) `
        -AllowFailure

    if ($reviewResult.ExitCode -ne 0) {
        Write-ValidationResult `
            -Status "SKIPPED_NO_REVIEW" `
            -Reason "review.json does not exist on origin/$Branch." `
            -BranchHead $branchHead

        return
    }

    $reviewText = $reviewResult.Output -join "`n"

    try {
        $review = $reviewText | ConvertFrom-Json
    }
    catch {
        Write-ValidationResult `
            -Status "BLOCKED_INVALID_REVIEW" `
            -Reason "review.json is not valid JSON." `
            -BranchHead $branchHead

        return
    }

    $reviewCommitResult = Invoke-Git -Arguments @(
        "log",
        "-1",
        "--format=%H",
        $remoteRef,
        "--",
        "review.json"
    )

    $reviewCommit = if ($reviewCommitResult.Output.Count -gt 0) {
        $reviewCommitResult.Output[0].Trim()
    }
    else {
        $null
    }

    $requiredProperties = @(
        "repository",
        "branch",
        "reviewed_commit",
        "verdict",
        "findings"
    )

    foreach ($property in $requiredProperties) {
        if ($review.PSObject.Properties.Name -notcontains $property) {
            Write-ValidationResult `
                -Status "BLOCKED_INVALID_REVIEW" `
                -Reason "review.json is missing required property: $property" `
                -Review $review `
                -ReviewCommit $reviewCommit `
                -BranchHead $branchHead

            return
        }
    }

    if ([string]$review.repository -ne $ExpectedRepository) {
        Write-ValidationResult `
            -Status "BLOCKED_REPOSITORY_MISMATCH" `
            -Reason "review.json repository does not match the configured repository." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    if ([string]$review.branch -ne $Branch) {
        Write-ValidationResult `
            -Status "BLOCKED_BRANCH_MISMATCH" `
            -Reason "review.json branch does not match the configured branch." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    $verdict = [string]$review.verdict

    if ($verdict -ne "changes_requested") {
        Write-ValidationResult `
            -Status "SKIPPED_VERDICT" `
            -Reason "Only changes_requested reviews may trigger repair." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    if (@($review.findings).Count -eq 0) {
        Write-ValidationResult `
            -Status "SKIPPED_NO_FINDINGS" `
            -Reason "changes_requested review has no findings." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    $reviewedCommit = [string]$review.reviewed_commit

    if ($reviewedCommit -notmatch "^[0-9a-fA-F]{40}$") {
        Write-ValidationResult `
            -Status "BLOCKED_INVALID_REVIEW" `
            -Reason "reviewed_commit is not a full 40-character Git SHA." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    $commitExists = Invoke-Git `
        -Arguments @("cat-file", "-e", "$reviewedCommit^{commit}") `
        -AllowFailure

    if ($commitExists.ExitCode -ne 0) {
        Write-ValidationResult `
            -Status "BLOCKED_UNKNOWN_COMMIT" `
            -Reason "reviewed_commit does not exist in the local Git object database." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    $ancestorCheck = Invoke-Git `
        -Arguments @(
            "merge-base",
            "--is-ancestor",
            $reviewedCommit,
            $remoteRef
        ) `
        -AllowFailure

    if ($ancestorCheck.ExitCode -ne 0) {
        Write-ValidationResult `
            -Status "SKIPPED_STALE_REVIEW" `
            -Reason "reviewed_commit is not an ancestor of the current dev branch." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    $commitListResult = Invoke-Git -Arguments @(
        "rev-list",
        "--first-parent",
        $remoteRef
    )

    $currentCodeHead = $null

    foreach ($commit in $commitListResult.Output) {
        $commit = $commit.Trim()

        if ([string]::IsNullOrWhiteSpace($commit)) {
            continue
        }

        $parentResult = Invoke-Git `
            -Arguments @("rev-parse", "$commit^1") `
            -AllowFailure

        if ($parentResult.ExitCode -eq 0) {
            $filesResult = Invoke-Git -Arguments @(
                "diff",
                "--name-only",
                "$commit^1",
                $commit
            )
        }
        else {
            $filesResult = Invoke-Git -Arguments @(
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                $commit
            )
        }

        $changedFiles = @(
            $filesResult.Output |
                ForEach-Object { $_.Trim() } |
                Where-Object {
                    -not [string]::IsNullOrWhiteSpace($_)
                }
        )

        $nonReviewFiles = @(
            $changedFiles |
                Where-Object { $_ -ne "review.json" }
        )

        if ($nonReviewFiles.Count -gt 0) {
            $currentCodeHead = $commit
            break
        }
    }

    if ([string]::IsNullOrWhiteSpace($currentCodeHead)) {
        Write-ValidationResult `
            -Status "BLOCKED_CODE_HEAD_NOT_FOUND" `
            -Reason "Unable to identify the latest non-review-only commit." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead

        return
    }

    if ($currentCodeHead -ne $reviewedCommit) {
        Write-ValidationResult `
            -Status "SKIPPED_STALE_REVIEW" `
            -Reason "Newer code exists after the reviewed commit." `
            -Review $review `
            -ReviewCommit $reviewCommit `
            -BranchHead $branchHead `
            -CurrentCodeHead $currentCodeHead

        return
    }

    Write-ValidationResult `
        -Status "WOULD_REPAIR" `
        -Reason "Review is current and eligible for repair. Phase 1 performs no changes." `
        -Review $review `
        -ReviewCommit $reviewCommit `
        -BranchHead $branchHead `
        -CurrentCodeHead $currentCodeHead
}
catch {
    Write-ValidationResult `
        -Status "BLOCKED_VALIDATION_ERROR" `
        -Reason $_.Exception.Message
}
