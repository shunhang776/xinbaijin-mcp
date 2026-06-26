[CmdletBinding()]
param(
    [string]$RepoRoot = "",

    [string]$ReviewedCommit = "",

    [switch]$ConfirmSubmit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    )
}

$repairRunPath = Join-Path $PSScriptRoot "repair-run.ps1"
$repairsRoot = Join-Path (Join-Path $RepoRoot ".baijin") "repairs"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Invoke-ProcessCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [string]$LogPath = ""
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $command = Get-Command $FilePath -ErrorAction Stop

        Push-Location $WorkingDirectory
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & $command.Source @Arguments 1> $stdoutPath 2> $stderrPath
            $exitCode = if ($null -ne $LASTEXITCODE) {
                [int]$LASTEXITCODE
            }
            else {
                0
            }
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
            Pop-Location
        }

        $stdout = [System.IO.File]::ReadAllText($stdoutPath)
        $stderr = [System.IO.File]::ReadAllText($stderrPath)

        if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
            $logText = @(
                "COMMAND: $FilePath $($Arguments -join ' ')",
                "EXIT_CODE: $exitCode",
                "",
                "STDOUT:",
                $stdout,
                "",
                "STDERR:",
                $stderr
            ) -join "`n"

            [System.IO.File]::WriteAllText(
                $LogPath,
                $logText + "`n",
                $utf8
            )
        }

        return [pscustomobject]@{
            ExitCode = $exitCode
            StdOut   = $stdout
            StdErr   = $stderr
        }
    }
    finally {
        Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Write-Result {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Data
    )

    $ordered = [ordered]@{
        protocol = "baijin-repair-submit/1.0"
    }

    foreach ($key in $Data.Keys) {
        $ordered[$key] = $Data[$key]
    }

    $ordered | ConvertTo-Json -Depth 15
}

function Resolve-ContextPath {
    param(
        [string]$Commit
    )

    if (-not [string]::IsNullOrWhiteSpace($Commit)) {
        if ($Commit -notmatch "^[0-9a-fA-F]{40}$") {
            throw "ReviewedCommit must be a full 40-character Git SHA."
        }

        return Join-Path `
            (Join-Path $repairsRoot $Commit.Substring(0, 8)) `
            "repair-context.json"
    }

    $latest = Get-ChildItem `
        -Path $repairsRoot `
        -Filter "repair-context.json" `
        -File `
        -Recurse `
        -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -eq $latest) {
        throw "No repair context exists. Run Prepare first."
    }

    return $latest.FullName
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "JSON file not found: $Path"
    }

    return (
        [System.IO.File]::ReadAllText($Path) |
            ConvertFrom-Json
    )
}

if (-not $ConfirmSubmit) {
    Write-Result -Data @{
        status = "BLOCKED_CONFIRMATION_REQUIRED"
        reason = "Run again with -ConfirmSubmit after manually inspecting the repair diff."
    }

    return
}

if (-not (Test-Path -LiteralPath $repairRunPath)) {
    throw "repair-run.ps1 not found: $repairRunPath"
}

$contextPath = Resolve-ContextPath -Commit $ReviewedCommit
$context = Read-JsonFile -Path $contextPath

$repository = [string]$context.repository
$branch = [string]$context.branch
$branchHead = [string]$context.branch_head
$reviewedCommitValue = [string]$context.reviewed_commit
$reviewCommit = [string]$context.review_commit
$repairBranch = [string]$context.repair_branch
$worktreePath = [string]$context.worktree_path
$short = $reviewedCommitValue.Substring(0, 8)
$repairDirectory = Split-Path -Parent $contextPath

$verifyResult = Invoke-ProcessCapture `
    -FilePath "powershell.exe" `
    -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $repairRunPath,
        "-Mode",
        "Verify",
        "-RepoRoot",
        $RepoRoot,
        "-ReviewedCommit",
        $reviewedCommitValue
    ) `
    -WorkingDirectory $RepoRoot `
    -LogPath (Join-Path $repairDirectory "submit-verify.log")

if ($verifyResult.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_VERIFY_PROCESS_FAILED"
        reviewed_commit = $reviewedCommitValue
        details         = $verifyResult.StdErr
    }

    return
}

try {
    $verify = $verifyResult.StdOut | ConvertFrom-Json
}
catch {
    Write-Result -Data @{
        status          = "BLOCKED_VERIFY_INVALID_OUTPUT"
        reviewed_commit = $reviewedCommitValue
        details         = $verifyResult.StdOut
    }

    return
}

if ([string]$verify.status -ne "READY_FOR_MANUAL_REVIEW") {
    Write-Result -Data @{
        status            = "BLOCKED_NOT_READY"
        reviewed_commit   = $reviewedCommitValue
        verification      = $verify
        push_performed    = $false
        pr_created        = $false
    }

    return
}

$fetch = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("fetch", "--prune", "origin", $branch) `
    -WorkingDirectory $RepoRoot `
    -LogPath (Join-Path $repairDirectory "submit-fetch.log")

if ($fetch.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_FETCH_FAILED"
        reviewed_commit = $reviewedCommitValue
        details         = $fetch.StdErr
    }

    return
}

$remoteHeadResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("rev-parse", "origin/$branch") `
    -WorkingDirectory $RepoRoot

$remoteHead = $remoteHeadResult.StdOut.Trim()

if ($remoteHeadResult.ExitCode -ne 0 -or $remoteHead -ne $branchHead) {
    Write-Result -Data @{
        status               = "BLOCKED_BRANCH_HEAD_CHANGED"
        reviewed_commit      = $reviewedCommitValue
        validated_branch_head = $branchHead
        current_branch_head  = $remoteHead
        push_performed       = $false
        pr_created           = $false
    }

    return
}

$currentBranchResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("branch", "--show-current") `
    -WorkingDirectory $worktreePath

$currentBranch = $currentBranchResult.StdOut.Trim()

if ($currentBranchResult.ExitCode -ne 0 -or $currentBranch -ne $repairBranch) {
    Write-Result -Data @{
        status          = "BLOCKED_REPAIR_BRANCH_MISMATCH"
        expected_branch = $repairBranch
        current_branch  = $currentBranch
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$remoteBranchCheck = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @(
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        "refs/heads/$repairBranch"
    ) `
    -WorkingDirectory $RepoRoot

if ($remoteBranchCheck.ExitCode -eq 0) {
    Write-Result -Data @{
        status          = "BLOCKED_REMOTE_BRANCH_EXISTS"
        repair_branch   = $repairBranch
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$existingPr = Invoke-ProcessCapture `
    -FilePath "gh.exe" `
    -Arguments @(
        "pr",
        "list",
        "--repo",
        $repository,
        "--state",
        "open",
        "--head",
        $repairBranch,
        "--json",
        "number,url,headRefName,baseRefName"
    ) `
    -WorkingDirectory $RepoRoot

if ($existingPr.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_GH_PR_LIST_FAILED"
        details         = $existingPr.StdErr
        push_performed  = $false
        pr_created      = $false
    }

    return
}

try {
    $existingPrJson = ([string]$existingPr.StdOut).Trim()

    if (
        [string]::IsNullOrWhiteSpace($existingPrJson) -or
        $existingPrJson -eq "[]"
    ) {
        $existingPrItems = @()
    }
    else {
        $existingPrItems = @($existingPrJson | ConvertFrom-Json)
    }
}
catch {
    $existingPrItems = @()
}

if ($existingPrItems.Count -gt 0) {
    Write-Result -Data @{
        status          = "SKIPPED_EXISTING_PR"
        repair_branch   = $repairBranch
        pull_requests   = $existingPrItems
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$changedPaths = @($verify.changed_paths | ForEach-Object { [string]$_ })

if ($changedPaths.Count -eq 0) {
    Write-Result -Data @{
        status          = "BLOCKED_NO_CHANGES"
        reviewed_commit = $reviewedCommitValue
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$addArguments = @("add", "--") + $changedPaths

$addResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments $addArguments `
    -WorkingDirectory $worktreePath `
    -LogPath (Join-Path $repairDirectory "submit-add.log")

if ($addResult.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_GIT_ADD_FAILED"
        details         = $addResult.StdErr
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$commitMessage = "fix: address review findings for $short"

$commitResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("commit", "-m", $commitMessage) `
    -WorkingDirectory $worktreePath `
    -LogPath (Join-Path $repairDirectory "submit-commit.log")

if ($commitResult.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_COMMIT_FAILED"
        details         = $commitResult.StdErr
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$repairCommitResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("rev-parse", "HEAD") `
    -WorkingDirectory $worktreePath

$repairCommit = $repairCommitResult.StdOut.Trim()

$secondFetch = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("fetch", "--prune", "origin", $branch) `
    -WorkingDirectory $RepoRoot

$secondRemoteHeadResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @("rev-parse", "origin/$branch") `
    -WorkingDirectory $RepoRoot

$secondRemoteHead = $secondRemoteHeadResult.StdOut.Trim()

if (
    $secondFetch.ExitCode -ne 0 -or
    $secondRemoteHeadResult.ExitCode -ne 0 -or
    $secondRemoteHead -ne $branchHead
) {
    Write-Result -Data @{
        status                = "BLOCKED_BRANCH_HEAD_CHANGED_AFTER_COMMIT"
        repair_commit         = $repairCommit
        validated_branch_head = $branchHead
        current_branch_head   = $secondRemoteHead
        push_performed        = $false
        pr_created            = $false
    }

    return
}

$pushResult = Invoke-ProcessCapture `
    -FilePath "git.exe" `
    -Arguments @(
        "push",
        "--set-upstream",
        "origin",
        $repairBranch
    ) `
    -WorkingDirectory $worktreePath `
    -LogPath (Join-Path $repairDirectory "submit-push.log")

if ($pushResult.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_PUSH_FAILED"
        repair_commit   = $repairCommit
        details         = $pushResult.StdErr
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$bodyPath = Join-Path $repairDirectory "pull-request-body.md"
$title = "fix: address review findings for $short"

$bodyLines = @(
    "Automated repair prepared by the Baijin review loop.",
    "",
    "Reviewed-Commit: $reviewedCommitValue",
    "Review-Commit: $reviewCommit",
    "Repair-Commit: $repairCommit",
    "Automation: baijin-repair/1.0",
    "",
    "Verification gates passed:",
    "- git diff --check",
    "- node --check worker.js",
    "- npm test",
    "- wrangler deploy --dry-run",
    "",
    "This pull request was created only after branch-head concurrency protection passed."
)

[System.IO.File]::WriteAllText(
    $bodyPath,
    ($bodyLines -join "`n") + "`n",
    $utf8
)

$prResult = Invoke-ProcessCapture `
    -FilePath "gh.exe" `
    -Arguments @(
        "pr",
        "create",
        "--repo",
        $repository,
        "--base",
        $branch,
        "--head",
        $repairBranch,
        "--title",
        $title,
        "--body-file",
        $bodyPath
    ) `
    -WorkingDirectory $worktreePath `
    -LogPath (Join-Path $repairDirectory "submit-pr-create.log")

if ($prResult.ExitCode -ne 0) {
    Write-Result -Data @{
        status          = "BLOCKED_PR_CREATE_FAILED"
        repair_branch   = $repairBranch
        repair_commit   = $repairCommit
        details         = $prResult.StdErr
        push_performed  = $true
        pr_created      = $false
    }

    return
}

$prUrl = $prResult.StdOut.Trim()

Write-Result -Data @{
    status          = "PR_CREATED"
    repository      = $repository
    base_branch     = $branch
    repair_branch   = $repairBranch
    reviewed_commit = $reviewedCommitValue
    review_commit   = $reviewCommit
    repair_commit   = $repairCommit
    pull_request_url = $prUrl
    push_performed  = $true
    pr_created      = $true
}
