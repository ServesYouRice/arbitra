# Starts arbitra on Windows: checks Node.js, installs and builds when they are missing or out of date, then opens the
# app on http://127.0.0.1:4178 in the default browser. Started by arbitra.cmd at the repository root. Everything it
# installs or builds stays inside this folder.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtime = Join-Path $root ".arbitra-runtime"
$logs = Join-Path $runtime "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$port = if ($env:ARBITRA_PORT) { $env:ARBITRA_PORT } else { "4178" }
$url = "http://127.0.0.1:$port"

function Say($text) { Write-Host "arbitra: $text" }

# 1. Node.js 22 or newer must be installed; arbitra does not install it.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$major = if ($node) { [int]((& node --version) -replace '^v(\d+)\..*$', '$1') } else { 0 }
if ($major -lt 22) {
  throw "arbitra needs Node.js 22 or newer$(if ($node) { " (found $(& node --version))" } else { ', and none was found' }). Install it from https://nodejs.org and start arbitra again."
}
Say "node $(& node --version)"

# 2. pnpm: corepack's (shipped with Node up to 24) in a folder of our own, else one already on PATH.
$shims = Join-Path $runtime "bin"
$corepack = Join-Path (Split-Path $node) "corepack.cmd"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
if (Test-Path $corepack) {
  New-Item -ItemType Directory -Force $shims | Out-Null
  & $corepack enable --install-directory $shims
  if ($LASTEXITCODE -ne 0) { throw "corepack could not set up pnpm (exit $LASTEXITCODE)" }
  # The build calls pnpm from inside pnpm, so it has to be on PATH.
  $env:PATH = "$shims;$env:PATH"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "arbitra needs pnpm 10. Run: npm install -g pnpm@10, then start arbitra again." }
function Pnpm { & pnpm @args; if ($LASTEXITCODE -ne 0) { throw "pnpm $args failed (exit $LASTEXITCODE)" } }

# 3. Install and build when missing, or when the source changed since the last build.
Set-Location $root
$stamp = Join-Path $runtime "built-from"
$current = try { (& git rev-parse HEAD) 2>$null } catch { "" }
if (-not $current) { $current = (Get-Item (Join-Path $root "pnpm-lock.yaml")).LastWriteTimeUtc.Ticks.ToString() }
$built = if (Test-Path $stamp) { Get-Content $stamp } else { "" }
$ready = (Test-Path "apps\server\dist\src\serve.js") -and (Test-Path "apps\web\dist\index.html") -and ($built -eq $current)
if (-not $ready) {
  Say "installing (first start or after an update: a few minutes)"
  Pnpm install --frozen-lockfile
  Say "building"
  Pnpm build
  Set-Content $stamp $current
}

# 4. Start, wait until it answers, open the browser. The window shows the log; closing it stops arbitra.
$log = Join-Path $logs ("arbitra-" + (Get-Date -Format "yyyy-MM-dd-HHmmss") + ".log")
Say "starting on $url (log: $log)"
$server = Start-Process $node -ArgumentList "apps\server\dist\src\serve.js" -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-WebRequest -UseBasicParsing "$url/runs" -TimeoutSec 2 | Out-Null; break } catch {}
  if ($server.HasExited) { Get-Content "$log.err" -Tail 20; throw "arbitra stopped while starting" }
}
Start-Process $url
Say "running. Keep this window open; close it to stop arbitra."
Wait-Process -Id $server.Id
