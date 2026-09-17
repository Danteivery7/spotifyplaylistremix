$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Playlist Remix Studio - Automatic Media Providers" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Leave any provider blank if you do not want to configure it yet." -ForegroundColor Gray
Write-Host "Credentials are saved only to your Windows user environment, not to Git." -ForegroundColor Gray
Write-Host ""

function Set-UserValue {
  param([string]$Name, [string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
}

function Read-Secret {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  if ($secure.Length -eq 0) { return "" }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host "Jamendo" -ForegroundColor Green
$jamendo = Read-Host "Jamendo Client ID"
if ($jamendo) { Set-UserValue "JAMENDO_CLIENT_ID" $jamendo.Trim() }

Write-Host ""
Write-Host "SoundCloud" -ForegroundColor Green
Write-Host "Requires a registered SoundCloud API app. The secret stays on this PC." -ForegroundColor DarkGray
$scClient = Read-Host "SoundCloud Client ID"
$scSecret = Read-Secret "SoundCloud Client Secret"
if ($scClient) { Set-UserValue "SOUNDCLOUD_CLIENT_ID" $scClient.Trim() }
if ($scSecret) { Set-UserValue "SOUNDCLOUD_CLIENT_SECRET" $scSecret.Trim() }

Write-Host ""
Write-Host "Audius" -ForegroundColor Green
Write-Host "Create an Audius API app/key. The Bearer Token is backend-only and stays on this PC." -ForegroundColor DarkGray
$audiusKey = Read-Host "Audius API Key"
$audiusBearer = Read-Secret "Audius Bearer Token"
if ($audiusKey) { Set-UserValue "AUDIUS_API_KEY" $audiusKey.Trim() }
if ($audiusBearer) { Set-UserValue "AUDIUS_BEARER_TOKEN" $audiusBearer.Trim() }
Set-UserValue "AUDIUS_APP_NAME" "PlaylistRemixStudio"

Write-Host ""
Write-Host "Saved. Close and reopen the engine launcher so it can read the new values." -ForegroundColor Cyan
Write-Host "The website's YouTube Data API key is configured separately; the same Google Cloud key used by your shared-music project can be reused if its restrictions allow this app." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close"
