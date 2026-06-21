[CmdletBinding()]
param(
    [string]$RepoRoot = "",

    [ValidateRange(10, 86400)]
    [int]$IntervalSeconds = 60,

    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    )
}

$validatorPath = Join-Path $PSScriptRoot "repair-validate.ps1"
$stateDirectory = Join-Path $RepoRoot ".baijin"
$statePath = Join-Path $stateDirectory "repair-state.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $validatorPath)) {
    throw "Validator not found: $validatorPath"
}

New-Item `
    -ItemType Directory `
    -Path $stateDirectory `
    -Force |
    Out-Null

function Read-PreviousState {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return $null
    }

    try {
        $text = [System.IO.File]::ReadAllText($statePath)

        if ([string]::IsNullOrWhiteSpace($text)) {
            return $null
        }

        return $text | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Write-State {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Result,

        [Parameter(Mandatory = $true)]
        [string]$Signature
    )

    $state = [ordered]@{
        signature = $Signature
        result    = $Result
        saved_at  = [DateTimeOffset]::UtcNow.ToString("o")
    }

    $json = $state | ConvertTo-Json -Depth 12

    [System.IO.File]::WriteAllText(
        $statePath,
        $json + "`n",
        $utf8
    )
}

do {
    try {
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $validatorPath,
            "-RepoRoot",
            $RepoRoot
        )

        $output = @(
            & powershell.exe @arguments 2>&1
        )

        $exitCode = $LASTEXITCODE
        $jsonText = $output -join "`n"

        if ($exitCode -ne 0) {
            throw "Validator exited with code $exitCode. Output: $jsonText"
        }

        if ([string]::IsNullOrWhiteSpace($jsonText)) {
            throw "Validator returned no output."
        }

        try {
            $result = $jsonText | ConvertFrom-Json
        }
        catch {
            throw "Validator did not return valid JSON. Output: $jsonText"
        }

        $signature = (
            "{0}|{1}|{2}|{3}" -f
            [string]$result.status,
            [string]$result.review_commit,
            [string]$result.reviewed_commit,
            [string]$result.current_code_head
        )

        $previousState = Read-PreviousState

        $previousSignature = if ($null -ne $previousState) {
            [string]$previousState.signature
        }
        else {
            ""
        }

        if ($signature -ne $previousSignature) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

            Write-Host ""
            Write-Host "[$timestamp] Baijin repair check"
            Write-Host ($result | ConvertTo-Json -Depth 12)

            Write-State `
                -Result $result `
                -Signature $signature
        }
    }
    catch {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

        Write-Host ""
        Write-Host "[$timestamp] BLOCKED_WATCH_ERROR"
        Write-Host $_.Exception.Message
    }

    if (-not $Once) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}
while (-not $Once)