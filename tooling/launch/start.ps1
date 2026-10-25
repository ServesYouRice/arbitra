# Starts arbitra on Windows: checks Node.js, sets up pnpm, installs and builds when they are missing or out of date,
# then opens the app on http://127.0.0.1:4178 in the default browser. Started by arbitra.cmd at the repository root.
# Everything it installs or builds stays inside this folder.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtime = Join-Path $root ".arbitra-runtime"
$logs = Join-Path $runtime "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$port = if ($env:ARBITRA_PORT) { $env:ARBITRA_PORT } else { "4178" }
$url = "http://127.0.0.1:$port"

function Say($text) { Write-Host "arbitra: $text" }

# 1. Node.js 22.13 or newer must be installed (any later version, current or LTS); arbitra does not install it.
$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$version = if ($node) { (& $node --version) -replace '^v', '' } else { "" }
$parts = $version.Split(".")
$supported = $node -and (([int]$parts[0] -gt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 13))
if (-not $supported) {
  $found = if ($node) { " (found $version)" } else { ", and none was found" }
  throw "arbitra needs Node.js 22.13 or newer$found. Install the current LTS from https://nodejs.org and start arbitra again."
}
Say "node $version"

# 2. pnpm 10, pinned, installed once into this folder with the npm that comes with every Node: no admin rights and no
# corepack, which Node 25 and later no longer ship. The build calls pnpm from inside pnpm, so it goes first on PATH.
$pnpmHome = Join-Path $runtime "pnpm"
$pnpmBin = Join-Path $pnpmHome "node_modules\.bin"
$pnpm = Join-Path $pnpmBin "pnpm.cmd"
if (-not (Test-Path $pnpm)) {
  Say "installing pnpm (once)"
  $npm = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $npm) { throw "npm was not found next to Node.js; reinstall Node.js from https://nodejs.org" }
  & $npm install --prefix $pnpmHome --no-audit --no-fund --loglevel=error pnpm@10.24.0
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pnpm)) { throw "pnpm could not be installed (exit $LASTEXITCODE)" }
}
$env:PATH = "$pnpmBin;$env:PATH"
# Named apart from pnpm: PowerShell names ignore case, and a function called Pnpm would call itself.
function Invoke-Pnpm { & $pnpm @args; if ($LASTEXITCODE -ne 0) { throw "pnpm $args failed (exit $LASTEXITCODE)" } }

# 3. Install and build when missing, or when the source changed since the last build.
Set-Location $root
$stamp = Join-Path $runtime "built-from"
$current = try { (& git rev-parse HEAD) 2>$null } catch { "" }
if (-not $current) { $current = (Get-Item (Join-Path $root "pnpm-lock.yaml")).LastWriteTimeUtc.Ticks.ToString() }
$built = if (Test-Path $stamp) { Get-Content $stamp } else { "" }
$ready = (Test-Path "apps\server\dist\src\serve.js") -and (Test-Path "apps\web\dist\index.html") -and ($built -eq $current)
if (-not $ready) {
  Say "installing (first start or after an update: a few minutes)"
  Invoke-Pnpm install --frozen-lockfile
  Say "building"
  Invoke-Pnpm build
  Set-Content $stamp $current
}

# 4. Start, wait until it answers, open the browser. The window shows the log; closing it stops arbitra.
$log = Join-Path $logs ("arbitra-" + (Get-Date -Format "yyyy-MM-dd-HHmmss") + ".log")
Say "starting on $url (log: $log)"
$server = Start-Process $node -ArgumentList "apps\server\dist\src\serve.js" -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
# Kept now, the handle lets the exit code be read once the process has ended.
$null = $server.Handle
# Wait for this server, not whatever answers on the port: an older arbitra left running there must not be opened.
$ours = $false
for ($i = 0; $i -lt 60 -and -not $ours -and -not $server.HasExited; $i++) {
  Start-Sleep -Milliseconds 500
  try { $ours = (Invoke-RestMethod "$url/diagnostics/server" -TimeoutSec 2).pid -eq $server.Id } catch {}
}
if (-not $ours -and $server.HasExited) {
  # It exits 0 when this build already runs there, and names another build when one does.
  if ($server.ExitCode -eq 0) { Say "already running on $url; opening it"; Start-Process $url; Start-Sleep -Seconds 3; return }
  Get-Content "$log.err" -Tail 20
  throw "arbitra stopped while starting"
}
Start-Process $url
Say "running. Keep this window open; close it to stop arbitra."
Wait-Process -Id $server.Id
