# Starts arbitra on Windows from a fresh download: a private Node 22 when the machine has none, the install and the
# build when they are missing or out of date, then the app on http://127.0.0.1:4178 in the default browser.
# Started by arbitra.cmd at the repository root. Everything it downloads or builds stays inside this folder.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtime = Join-Path $root ".arbitra-runtime"
$logs = Join-Path $runtime "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$nodeVersion = "22.23.2"
$port = if ($env:ARBITRA_PORT) { $env:ARBITRA_PORT } else { "4178" }
$url = "http://127.0.0.1:$port"

function Say($text) { Write-Host "arbitra · $text" }

# 1. Node 22: the one on PATH when it is 22.x, otherwise a private copy in .arbitra-runtime.
$node = $null
try { $found = (& node --version) 2>$null; if ($found -match '^v22\.') { $node = (Get-Command node).Source } } catch {}
if (-not $node) {
  $private = Join-Path $runtime "node-v$nodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $private "node.exe"))) {
    Say "downloading Node $nodeVersion (once, about 30 MB)"
    $zip = Join-Path $runtime "node.zip"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $runtime -Force
    Remove-Item $zip
  }
  $env:PATH = "$private;$env:PATH"
  $node = Join-Path $private "node.exe"
}
Say "node $(& $node --version)"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
$corepack = Join-Path (Split-Path $node) "corepack.cmd"
function Pnpm { & $corepack pnpm @args; if ($LASTEXITCODE -ne 0) { throw "pnpm $args failed (exit $LASTEXITCODE)" } }

# 2. Install and build when missing, or when the source changed since the last build.
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

# 3. Start, wait until it answers, open the browser. The window shows the log; closing it stops arbitra.
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
