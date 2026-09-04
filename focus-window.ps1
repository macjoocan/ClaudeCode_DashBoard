# Bring the terminal window that owns a running claude session to the front.
# claude.exe has no window of its own, so walk up the parent chain
# (claude -> powershell -> WindowsTerminal) to the first process with a window.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM,
# so non-ASCII text here would corrupt the script. Korean messages live in server.js.
param([Parameter(Mandatory=$true)][int]$TargetPid)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace CCL -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

function Get-OwnerWindow([int]$startPid) {
  $cur = $startPid
  for ($i = 0; $i -lt 8 -and $cur -gt 4; $i++) {
    try { $proc = Get-Process -Id $cur -ErrorAction Stop } catch { return $null }
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
      return [pscustomobject]@{ Handle = $proc.MainWindowHandle; Name = $proc.ProcessName; Id = $proc.Id }
    }
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $ci -or -not $ci.ParentProcessId) { return $null }
    $cur = [int]$ci.ParentProcessId
  }
  return $null
}

$target = Get-OwnerWindow -startPid $TargetPid
if (-not $target) { Write-Output "NOTFOUND"; exit 1 }

$h = $target.Handle

# Focusing another process's window requires attaching to the foreground thread.
$fg = [CCL.Win]::GetForegroundWindow()
$fgTid = 0
if ($fg -ne [IntPtr]::Zero) {
  $outPid = 0
  $fgTid = [CCL.Win]::GetWindowThreadProcessId($fg, [ref]$outPid)
}
$myTid = [CCL.Win]::GetCurrentThreadId()
$attached = $false
if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
  $attached = [CCL.Win]::AttachThreadInput($myTid, $fgTid, $true)
}

if ([CCL.Win]::IsIconic($h)) { [CCL.Win]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
[CCL.Win]::ShowWindow($h, 5) | Out-Null                                    # SW_SHOW
$ok = [CCL.Win]::SetForegroundWindow($h)

if ($attached) { [CCL.Win]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null }

if ($ok) { Write-Output "OK $($target.Name) $($target.Id)"; exit 0 }
Write-Output "FAILED $($target.Name) $($target.Id)"
exit 1
