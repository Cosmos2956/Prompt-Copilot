$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$localCargo = Join-Path $PSScriptRoot '.tools\cargo'
if (Test-Path (Join-Path $localCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $PSScriptRoot '.tools\rustup'
    $env:PATH = "$(Join-Path $localCargo 'bin');$env:PATH"
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCommand) {
    $pnpmPath = $pnpmCommand.Source
} else {
    $pnpmPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (-not (Test-Path $pnpmPath)) {
        throw 'pnpm was not found. Install Node.js and pnpm, then run release.ps1 again.'
    }
    $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
    $env:PATH = "$(Split-Path $pnpmPath -Parent);$runtimeNode;$env:PATH"
}

# Build separately so packaging never overwrites a running portable executable.
$env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'src-tauri\target\installer'
# Use the installed dependencies without an implicit install during packaging.
$env:pnpm_config_verify_deps_before_run = 'false'
& $pnpmPath --config.verifyDepsBeforeRun=false tauri build --bundles nsis
exit $LASTEXITCODE
