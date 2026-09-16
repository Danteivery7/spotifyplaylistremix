param(
  [switch]$EnableStems,
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$EngineRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $EngineRoot

Write-Host ""
Write-Host "Playlist Remix Studio - Personal Engine" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

function Ensure-WingetPackage {
  param([string]$Command, [string]$PackageId, [string]$Label)
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$Label is required, and winget was not found. Install $Label, then run this launcher again."
  }
  Write-Host "Installing $Label..." -ForegroundColor Yellow
  winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Label was installed but is not on PATH yet. Close this window, open it again, and rerun the launcher."
  }
}

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python Launcher was not found. Install Python 3.12 or newer from python.org, then run this launcher again."
}

Ensure-WingetPackage -Command "ffmpeg" -PackageId "Gyan.FFmpeg" -Label "FFmpeg"
Ensure-WingetPackage -Command "cloudflared" -PackageId "Cloudflare.cloudflared" -Label "Cloudflare Tunnel"

$Venv = Join-Path $EngineRoot ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $Python)) {
  Write-Host "Creating Python environment..." -ForegroundColor Yellow
  py -3.12 -m venv $Venv
}

Write-Host "Installing/updating remix engine dependencies..." -ForegroundColor Yellow
& $Python -m pip install --disable-pip-version-check --upgrade pip
if ($EnableStems) {
  & $Python -m pip install -e ".[stems]"
} else {
  & $Python -m pip install -e "."
}

$MediaPath = Join-Path $EngineRoot "media"
$OutputPath = Join-Path $EngineRoot "output"
New-Item -ItemType Directory -Force -Path $MediaPath | Out-Null
New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null

$EngineScript = @"
`$env:MEDIA_LIBRARY_PATH='$MediaPath'
`$env:OUTPUT_PATH='$OutputPath'
`$env:WEB_ORIGINS='*'
`$env:MAX_AUDIO_UPLOAD_MB='96'
Set-Location '$EngineRoot'
& '$Python' -m uvicorn app.main:app --host 127.0.0.1 --port $Port
"@

Write-Host "Starting remix engine on port $Port..." -ForegroundColor Green
$Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($EngineScript))
Start-Process powershell -ArgumentList "-NoExit", "-EncodedCommand", $Encoded

Start-Sleep -Seconds 3
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 10
  Write-Host "Engine online: version $($health.version)" -ForegroundColor Green
} catch {
  Write-Host "The engine window opened, but the health check is not ready yet." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting a temporary HTTPS Cloudflare Tunnel..." -ForegroundColor Cyan
Write-Host "When cloudflared prints a URL ending in trycloudflare.com, copy that URL." -ForegroundColor White
Write-Host "On Playlist Remix Studio: Audio Sources -> Engine Settings -> paste URL -> Save Engine." -ForegroundColor White
Write-Host "Keep BOTH this window and the engine window open while a mix is rendering." -ForegroundColor Yellow
Write-Host ""

cloudflared tunnel --url "http://127.0.0.1:$Port"
