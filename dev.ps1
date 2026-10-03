$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$ErrorActionPreference = 'Stop'

# Release and development builds share the same shortcut. Never start development
# over a running build from this project (including the obsolete backup binary).
$runningCopilot = Get-Process -Name 'prompt-copilot', 'prompt-copilot-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($projectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) }
if ($runningCopilot) {
    throw "Prompt Copilot is already running (process IDs: $($runningCopilot.Id -join ', ')). Close those project instances in Task Manager before starting development."
}
$localCargo = Join-Path $projectRoot '.tools\cargo'

if (Test-Path (Join-Path $localCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = "$(Join-Path $localCargo 'bin');$env:PATH"
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue

if ($pnpmCommand) {
    $pnpmPath = $pnpmCommand.Source
} else {
    $pnpmPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (-not (Test-Path $pnpmPath)) {
        throw 'pnpm was not found. Install Node.js and pnpm, then run dev.ps1 again.'
    }
    $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
    $env:PATH = "$(Split-Path $pnpmPath -Parent);$runtimeNode;$env:PATH"
}

& $pnpmPath tauri dev
exit $LASTEXITCODE
