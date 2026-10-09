# Starts the recorder API and the Telegram bot, then keeps them running.
# If either stops, both are restarted. The tunnel mode comes from backend\.env:
#
#   quick (default)
#     Opens a temporary trycloudflare.com URL. Useful for a phone check.
#     Do not point the Vercel Mini App at it.
#   named
#     Set CLOUDFLARE_TUNNEL_NAME and a stable https TELEGRAM_PUBLIC_BASE_URL.
#     This script runs `cloudflared tunnel run` and keeps that hostname.
#   external
#     Set CLOUDFLARE_TUNNEL_EXTERNAL=1 when cloudflared is already a Windows
#     service. This script starts only the API and the bot.
#
# Required in backend\.env (that file is not committed):
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_ALLOWED_USER_IDS=123456789
#
# Requires Node and cloudflared on PATH.
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\keep-alive.ps1

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Backend = Join-Path $Root 'backend'
$DataDir = Join-Path $Backend 'data'
$LogPath = Join-Path $DataDir 'keep-alive.log'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogPath -Value $line
  Write-Host $line
}

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  foreach ($raw in Get-Content -Path $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) { continue }
    Set-Item -Path "Env:$key" -Value $val
  }
}

Import-DotEnv (Join-Path $Backend '.env')

if (-not $env:TELEGRAM_BOT_TOKEN) {
  throw 'Set TELEGRAM_BOT_TOKEN in backend\.env. Do not paste the token into chat.'
}
if (-not $env:TELEGRAM_ALLOWED_USER_IDS) {
  throw 'Set TELEGRAM_ALLOWED_USER_IDS in backend\.env to your numeric Telegram user ID.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not on PATH.'
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw 'cloudflared is not on PATH. Install Cloudflare cloudflared, then run this script again.'
}
if (-not $env:BACKEND_PORT) { $env:BACKEND_PORT = '3001' }

$script:Children = @()

function Stop-Children {
  foreach ($proc in $script:Children) {
    if ($proc -and -not $proc.HasExited) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  $script:Children = @()
}

function Start-LoggedProcess([string]$File, [string[]]$ArgumentList, [string]$Stdout, [string]$Stderr) {
  $proc = Start-Process -FilePath $File -ArgumentList $ArgumentList -WorkingDirectory $Backend -PassThru -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr
  $script:Children += $proc
  return $proc
}

function Wait-ForUrl([string]$ErrFile, [System.Diagnostics.Process]$Proc, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ($Proc.HasExited) { return $null }
    if (Test-Path $ErrFile) {
      $text = Get-Content -Path $ErrFile -Raw -ErrorAction SilentlyContinue
      $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($match.Success) { return $match.Value }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Tunnel-Mode {
  $base = [string]$env:TELEGRAM_PUBLIC_BASE_URL
  $stable = $base -and ($base -notmatch 'trycloudflare\.com') -and ($base -match '^https://')
  if ($env:CLOUDFLARE_TUNNEL_EXTERNAL -eq '1') {
    if (-not $stable) {
      throw 'CLOUDFLARE_TUNNEL_EXTERNAL=1 needs TELEGRAM_PUBLIC_BASE_URL set to the stable https hostname.'
    }
    return 'external'
  }
  if ($env:CLOUDFLARE_TUNNEL_NAME -and $stable) { return 'named' }
  return 'quick'
}

function Wait-ForPort([int]$Port, [System.Diagnostics.Process]$Proc, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ($Proc.HasExited) { return $false }
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', $Port)
      $client.Close()
      return $true
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}

Write-Log 'Keep-alive started. Token is loaded and will not be printed.'

try {
  while ($true) {
    Stop-Children
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $apiOut = Join-Path $DataDir "api-$stamp.out.log"
    $apiErr = Join-Path $DataDir "api-$stamp.err.log"
    $tunOut = Join-Path $DataDir "tunnel-$stamp.out.log"
    $tunErr = Join-Path $DataDir "tunnel-$stamp.err.log"
    $botOut = Join-Path $DataDir "bot-$stamp.out.log"
    $botErr = Join-Path $DataDir "bot-$stamp.err.log"

    $api = Start-LoggedProcess 'node' @('server.js') $apiOut $apiErr
    if (-not (Wait-ForPort ([int]$env:BACKEND_PORT) $api 30)) {
      Write-Log 'Recorder API did not open its port. Retrying in 5 seconds.'
      Start-Sleep -Seconds 5
      continue
    }
    Write-Log ("Recorder API is listening on port {0}." -f $env:BACKEND_PORT)

    $mode = Tunnel-Mode
    $tunnel = $null
    if ($mode -eq 'external') {
      Set-Content -Path (Join-Path $DataDir 'public-url.txt') -Value $env:TELEGRAM_PUBLIC_BASE_URL
      Write-Log 'Stable recorder URL is set. Cloudflare Tunnel is managed outside this script.'
    } elseif ($mode -eq 'named') {
      $tunnel = Start-LoggedProcess 'cloudflared' @('tunnel', 'run', $env:CLOUDFLARE_TUNNEL_NAME) $tunOut $tunErr
      Start-Sleep -Seconds 3
      if ($tunnel.HasExited) {
        Write-Log 'Named Cloudflare Tunnel exited. Retrying in 5 seconds.'
        Start-Sleep -Seconds 5
        continue
      }
      Set-Content -Path (Join-Path $DataDir 'public-url.txt') -Value $env:TELEGRAM_PUBLIC_BASE_URL
      Write-Log ("Named tunnel {0} is running." -f $env:CLOUDFLARE_TUNNEL_NAME)
    } else {
      $tunnel = Start-LoggedProcess 'cloudflared' @('tunnel', '--url', "http://127.0.0.1:$($env:BACKEND_PORT)", '--no-autoupdate') $tunOut $tunErr
      $publicUrl = Wait-ForUrl $tunErr $tunnel 40
      if (-not $publicUrl) { $publicUrl = Wait-ForUrl $tunOut $tunnel 5 }
      if (-not $publicUrl) {
        Write-Log 'Cloudflare did not publish a public URL. Retrying in 5 seconds.'
        Start-Sleep -Seconds 5
        continue
      }
      Set-Content -Path (Join-Path $DataDir 'public-url.txt') -Value $publicUrl
      $env:TELEGRAM_PUBLIC_BASE_URL = $publicUrl
      Write-Log ("Public URL is {0}" -f $publicUrl)
    }

    $bot = Start-LoggedProcess 'node' @('telegram-bot.js') $botOut $botErr
    Write-Log 'Telegram bot process started.'

    while (-not $api.HasExited -and -not $bot.HasExited -and ($null -eq $tunnel -or -not $tunnel.HasExited)) {
      Start-Sleep -Seconds 2
    }
    Write-Log 'A process exited. Restarting the API, tunnel, and bot together.'
    Start-Sleep -Seconds 3
  }
} finally {
  Stop-Children
  Write-Log 'Keep-alive stopped.'
}
