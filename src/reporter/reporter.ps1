# Claude Code UserPromptSubmit command hook - Windows (see registerHooks).
#
# Run directly by powershell.exe via an exec-form hook, so there is no wrapping
# shell. Claude pipes the hook's JSON payload to stdin. PowerShell is spawned
# straight by Claude, so its own process-ancestor chain - $PID -> claude ->
# ... -> the VS Code terminal's shell - is intact and walkable from here. (A
# Node/Electron child cannot do this on Windows: the Electron bootstrap
# re-spawns the real process and exits, orphaning it and severing the chain.)
#
# It walks that chain, injects the PID list into the payload as `ancestorPids`,
# and POSTs the result to the server's /update-chat-state endpoint. The
# extension then matches one of those PIDs to a Terminal's shell PID.
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less script as ANSI, so any
# non-ASCII byte here would be mis-decoded and could corrupt parsing.
#
# Best-effort throughout: a hook error is non-blocking, and what happened is
# left in ~/.takeshicc/reporter.log.

param([int]$Port)
$ErrorActionPreference = 'SilentlyContinue'

$dir = Join-Path $HOME '.takeshicc'
function Log($m) {
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Add-Content -Path (Join-Path $dir 'reporter.log') -Value (
      '{0} [ps {1}] {2}' -f (Get-Date -Format o), $PID, $m)
  } catch {}
}

Log "started, server port $Port"

# Read the hook payload from stdin as UTF-8, independent of the console codepage.
$raw = ''
try {
  $reader = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $reader.ReadToEnd()
  $reader.Close()
} catch {
  Log "stdin read failed: $($_.Exception.Message)"
}
if (-not $raw) { Log 'empty stdin payload'; exit 0 }

try {
  $payload = $raw | ConvertFrom-Json
} catch {
  Log 'unparseable stdin payload'
  exit 0
}
$sid = [string]$payload.session_id
if (-not $sid) { Log 'payload has no session_id'; exit 0 }

# Walk this process's ancestor chain. PowerShell is a direct child of Claude,
# so the chain reaches up through Claude to the terminal's shell.
$parent = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $parent[[int]$_.ProcessId] = [int]$_.ParentProcessId
}
$pids = @()
$p = $PID
for ($i = 0; $i -lt 64; $i++) {
  if (-not $parent.ContainsKey($p)) { break }
  $pp = $parent[$p]
  if ($pp -le 1 -or ($pids -contains $pp)) { break }
  $pids += $pp
  $p = $pp
}
Log "session $sid ancestorPids [$($pids -join ', ')]"

# Inject "ancestorPids":[...] right after the payload's opening brace - string
# surgery, so a single-element list still serialises as a JSON array and the
# rest of the payload is forwarded unchanged.
$trimmed = $raw.Trim()
if (-not $trimmed.StartsWith('{')) { Log 'payload is not a JSON object'; exit 0 }
$body = '{"ancestorPids":[' + ($pids -join ',') + '],' + $trimmed.Substring(1)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/update-chat-state" `
    -Method Post -ContentType 'application/json' -Body $bytes -TimeoutSec 5 | Out-Null
  Log "session $sid POST ok"
} catch {
  Log "session $sid POST failed: $($_.Exception.Message)"
}
exit 0
