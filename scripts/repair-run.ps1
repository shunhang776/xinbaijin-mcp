[CmdletBinding()]
param(
    [ValidateSet("Prepare", "Verify", "Cleanup")]
    [string]$Mode = "Prepare",

    [string]$RepoRoot = "",

    [string]$Branch = "dev",

    [string]$ReviewedCommit = "",

    [string[]]$AllowPath = @(),

    [switch]$DeleteBranch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    )
}

$validatorPath = Join-Path $PSScriptRoot "repair-validate.ps1"
$promptScriptPath = Join-Path $PSScriptRoot "repair-prompt.ps1"
$stateRoot = Join-Path $RepoRoot ".baijin"
$repairsRoot = Join-Path $stateRoot "repairs"
$worktreesRoot = Join-Path $stateRoot "worktrees"

New-Item -ItemType Directory -Path $repairsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $worktreesRoot -Force | Out-Null

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

        $process = Start-Process `
            -FilePath $command.Source `
            -ArgumentList $Arguments `
            -WorkingDirectory $WorkingDirectory `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        $stdout = [System.IO.File]::ReadAllText($stdoutPath)
        $stderr = [System.IO.File]::ReadAllText($stderrPath)

        if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            $logText = @(
                "COMMAND: $FilePath $($Arguments -join ' ')",
                "EXIT_CODE: $($process.ExitCode)",
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
            ExitCode = $process.ExitCode
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
        protocol = "baijin-repair-run/1.0"
    }

    foreach ($key in $Data.Keys) {
        $ordered[$key] = $Data[$key]
    }

    $ordered | ConvertTo-Json -Depth 15
}

function Invoke-Validator {
    if (-not (Test-Path -LiteralPath $validatorPath)) {
        throw "Validator not found: $validatorPath"
    }

    $result = Invoke-ProcessCapture `
        -FilePath "powershell.exe" `
        -Arguments @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $validatorPath,
            "-RepoRoot",
            $RepoRoot
        ) `
        -WorkingDirectory $RepoRoot

    if ($result.ExitCode -ne 0) {
        throw "Validator failed. $($result.StdErr)"
    }

    try {
        return $result.StdOut | ConvertFrom-Json
    }
    catch {
        throw "Validator did not return valid JSON. Output: $($result.StdOut)"
    }
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

function Read-Context {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Repair context not found: $Path"
    }

    return (
        [System.IO.File]::ReadAllText($Path) |
            ConvertFrom-Json
    )
}

function Get-ChangedPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorktreePath
    )

    $result = Invoke-ProcessCapture `
        -FilePath "git.exe" `
        -Arguments @("status", "--short") `
        -WorkingDirectory $WorktreePath

    if ($result.ExitCode -ne 0) {
        throw "Unable to read worktree status. $($result.StdErr)"
    }

    $paths = New-Object System.Collections.Generic.List[string]

    foreach ($line in ($result.StdOut -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        if ($line.Length -lt 4) {
            continue
        }

        $path = $line.Substring(3).Trim()

        if ($path.Contains(" -> ")) {
            $path = ($path -split " -> ")[-1].Trim()
        }

        if (-not [string]::IsNullOrWhiteSpace($path)) {
            $paths.Add($path.Replace("\", "/"))
        }
    }

    return @($paths | Sort-Object -Unique)
}

function Test-AllowedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string[]]$AllowedFiles,

        [Parameter(Mandatory = $true)]
        [string[]]$ExtraPatterns
    )

    $normalized = $Path.Replace("\", "/")

    if ($normalized -eq "review.json") {
        return $false
    }

    foreach ($file in $AllowedFiles) {
        if ($normalized -eq ([string]$file).Replace("\", "/")) {
            return $true
        }
    }

    $patterns = @(
        "test/*",
        "tests/*",
        "*/test/*",
        "*/tests/*"
    ) + $ExtraPatterns

    foreach ($pattern in $patterns) {
        if ($normalized -like $pattern) {
            return $true
        }
    }

    return $false
}

if ($Mode -eq "Prepare") {
    $validation = Invoke-Validator

    if ([string]$validation.status -ne "WOULD_REPAIR") {
        Write-Result -Data @{
            mode              = "Prepare"
            status            = "SKIPPED_NOT_ELIGIBLE"
            validation_status = [string]$validation.status
            reason            = [string]$validation.reason
            reviewed_commit   = [string]$validation.reviewed_commit
            review_commit     = [string]$validation.review_commit
        }

        return
    }

    $ReviewedCommit = [string]$validation.reviewed_commit
    $reviewCommit = [string]$validation.review_commit
    $short = $ReviewedCommit.Substring(0, 8)
    $repairBranch = "fix/review-$short"
    $repairDirectory = Join-Path $repairsRoot $short
    $worktreePath = Join-Path $worktreesRoot $short
    $promptPath = Join-Path $repairDirectory "repair-prompt.txt"
    $contextPath = Join-Path $repairDirectory "repair-context.json"

    if (Test-Path -LiteralPath $worktreePath) {
        Write-Result -Data @{
            mode            = "Prepare"
            status          = "BLOCKED_WORKTREE_EXISTS"
            reviewed_commit = $ReviewedCommit
            worktree_path   = $worktreePath
        }

        return
    }

    $branchCheck = Invoke-ProcessCapture `
        -FilePath "git.exe" `
        -Arguments @(
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/$repairBranch"
        ) `
        -WorkingDirectory $RepoRoot

    if ($branchCheck.ExitCode -eq 0) {
        Write-Result -Data @{
            mode            = "Prepare"
            status          = "BLOCKED_BRANCH_EXISTS"
            reviewed_commit = $ReviewedCommit
            repair_branch   = $repairBranch
        }

        return
    }

    New-Item -ItemType Directory -Path $repairDirectory -Force | Out-Null

    $worktreeResult = Invoke-ProcessCapture `
        -FilePath "git.exe" `
        -Arguments @(
            "worktree",
            "add",
            "-b",
            $repairBranch,
            $worktreePath,
            $ReviewedCommit
        ) `
        -WorkingDirectory $RepoRoot `
        -LogPath (Join-Path $repairDirectory "worktree-add.log")

    if ($worktreeResult.ExitCode -ne 0) {
        Write-Result -Data @{
            mode            = "Prepare"
            status          = "BLOCKED_WORKTREE_CREATE_FAILED"
            reviewed_commit = $ReviewedCommit
            repair_branch   = $repairBranch
            details         = $worktreeResult.StdErr
        }

        return
    }

    $promptResult = Invoke-ProcessCapture `
        -FilePath "powershell.exe" `
        -Arguments @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $promptScriptPath,
            "-RepoRoot",
            $RepoRoot,
            "-ReviewedCommit",
            $ReviewedCommit,
            "-ReviewCommit",
            $reviewCommit,
            "-BranchHead",
            ([string]$validation.branch_head),
            "-WorktreePath",
            $worktreePath,
            "-OutputPath",
            $promptPath,
            "-ContextPath",
            $contextPath
        ) `
        -WorkingDirectory $RepoRoot `
        -LogPath (Join-Path $repairDirectory "prompt-create.log")

    if ($promptResult.ExitCode -ne 0) {
        Write-Result -Data @{
            mode            = "Prepare"
            status          = "BLOCKED_PROMPT_CREATE_FAILED"
            reviewed_commit = $ReviewedCommit
            repair_branch   = $repairBranch
            worktree_path   = $worktreePath
            details         = $promptResult.StdErr
        }

        return
    }

    Write-Result -Data @{
        mode            = "Prepare"
        status          = "PREPARED"
        reviewed_commit = $ReviewedCommit
        review_commit   = $reviewCommit
        repair_branch   = $repairBranch
        worktree_path   = $worktreePath
        prompt_path     = $promptPath
        context_path    = $contextPath
        next_step       = "Open Claude Code in the worktree, apply the prompt, then run Verify."
        push_performed  = $false
        pr_created      = $false
    }

    return
}

$resolvedContextPath = Resolve-ContextPath -Commit $ReviewedCommit
$context = Read-Context -Path $resolvedContextPath
$worktreePath = [string]$context.worktree_path
$repairBranch = [string]$context.repair_branch
$reviewedCommitFromContext = [string]$context.reviewed_commit

if ($Mode -eq "Cleanup") {
    if (Test-Path -LiteralPath $worktreePath) {
        $removeResult = Invoke-ProcessCapture `
            -FilePath "git.exe" `
            -Arguments @(
                "worktree",
                "remove",
                "--force",
                $worktreePath
            ) `
            -WorkingDirectory $RepoRoot

        if ($removeResult.ExitCode -ne 0) {
            throw "Unable to remove worktree. $($removeResult.StdErr)"
        }
    }

    if ($DeleteBranch) {
        $deleteResult = Invoke-ProcessCapture `
            -FilePath "git.exe" `
            -Arguments @(
                "branch",
                "-D",
                $repairBranch
            ) `
            -WorkingDirectory $RepoRoot

        if ($deleteResult.ExitCode -ne 0) {
            throw "Unable to delete repair branch. $($deleteResult.StdErr)"
        }
    }

    Write-Result -Data @{
        mode            = "Cleanup"
        status          = "CLEANED"
        reviewed_commit = $reviewedCommitFromContext
        repair_branch   = $repairBranch
        worktree_path   = $worktreePath
        branch_deleted  = [bool]$DeleteBranch
    }

    return
}

if (-not (Test-Path -LiteralPath $worktreePath)) {
    Write-Result -Data @{
        mode            = "Verify"
        status          = "BLOCKED_WORKTREE_MISSING"
        reviewed_commit = $reviewedCommitFromContext
        worktree_path   = $worktreePath
    }

    return
}

$changedPaths = @(Get-ChangedPaths -WorktreePath $worktreePath)

if ($changedPaths.Count -eq 0) {
    Write-Result -Data @{
        mode            = "Verify"
        status          = "BLOCKED_NO_CHANGES"
        reviewed_commit = $reviewedCommitFromContext
        worktree_path   = $worktreePath
    }

    return
}

$allowedFiles = @($context.allowed_files | ForEach-Object { [string]$_ })
$unexpectedPaths = New-Object System.Collections.Generic.List[string]

foreach ($path in $changedPaths) {
    if (
        -not (
            Test-AllowedPath `
                -Path $path `
                -AllowedFiles $allowedFiles `
                -ExtraPatterns $AllowPath
        )
    ) {
        $unexpectedPaths.Add($path)
    }
}

if ($unexpectedPaths.Count -gt 0) {
    Write-Result -Data @{
        mode             = "Verify"
        status           = "BLOCKED_UNEXPECTED_PATH"
        reviewed_commit  = $reviewedCommitFromContext
        changed_paths    = $changedPaths
        unexpected_paths = @($unexpectedPaths)
        allowed_files    = $allowedFiles
    }

    return
}

$repairDirectory = Split-Path -Parent $resolvedContextPath
$gates = New-Object System.Collections.Generic.List[object]

$gateDefinitions = @(
    @{
        name      = "git-diff-check"
        file      = "git.exe"
        arguments = @("diff", "--check")
    },
    @{
        name      = "node-check-worker"
        file      = "node.exe"
        arguments = @("--check", ".\worker.js")
    },
    @{
        name      = "npm-test"
        file      = "npm.cmd"
        arguments = @("test")
    },
    @{
        name      = "wrangler-dry-run"
        file      = "npx.cmd"
        arguments = @("wrangler", "deploy", "--dry-run")
    }
)

foreach ($definition in $gateDefinitions) {
    $logPath = Join-Path $repairDirectory "$($definition.name).log"

    $gateResult = Invoke-ProcessCapture `
        -FilePath $definition.file `
        -Arguments $definition.arguments `
        -WorkingDirectory $worktreePath `
        -LogPath $logPath

    $gates.Add([ordered]@{
        name      = $definition.name
        exit_code = $gateResult.ExitCode
        log_path  = $logPath
    })

    if ($gateResult.ExitCode -ne 0) {
        Write-Result -Data @{
            mode            = "Verify"
            status          = "REPAIR_FAILED_TEST_GATE"
            reviewed_commit = $reviewedCommitFromContext
            repair_branch   = $repairBranch
            worktree_path   = $worktreePath
            changed_paths   = $changedPaths
            failed_gate     = $definition.name
            gates           = @($gates)
            push_performed  = $false
            pr_created      = $false
        }

        return
    }
}

Write-Result -Data @{
    mode            = "Verify"
    status          = "READY_FOR_MANUAL_REVIEW"
    reviewed_commit = $reviewedCommitFromContext
    repair_branch   = $repairBranch
    worktree_path   = $worktreePath
    prompt_path     = [string]$context.prompt_path
    changed_paths   = $changedPaths
    gates           = @($gates)
    push_performed  = $false
    pr_created      = $false
    next_step       = "Inspect the diff manually. Phase 2 does not commit, push, or create a PR."
}
