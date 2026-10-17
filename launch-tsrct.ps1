# ============================================================================
#  TSRCT one-click launcher  (orchestrator + branded splash)
#  Flow: start WSL2 + node server.js (hidden) -> show splash with a REAL
#  progress bar tied to boot milestones -> wait for the server's [READY] line
#  -> open the app. Zero install: Windows PowerShell + WinForms.
#  The splash art (splash.png) is the FRAME only; title/progress/status are
#  drawn on top with GDI+ (no transparency issues, neon glow).
#
#  -WaitPortFree: used by /api/restart. Waits (max 15s) for the OLD server to
#  let go of the port before booting, so the "already online?" check below does
#  not see the dying process. This replaced an inline -EncodedCommand, which
#  Windows Defender flagged as Trojan:Win32/Commando.A!ml on 2026-09-22.
# ============================================================================
param([switch]$WaitPortFree)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- config / paths ---------------------------------------------------------
$root      = $PSScriptRoot
$logWin    = Join-Path $root '.tsrct-boot.log'
$splashPng = Join-Path $root 'splash.png'     # horizontal FRAME art (no text)
$logoPng   = Join-Path $root 'logo.png'       # fallback art
$distro    = 'Ubuntu'
$port      = 3847
$url       = "http://localhost:$port"
# Chrome profile the app (and every link opened from it -- SF orgs, Slack,
# ClickUp) must run under. "Default" = the WORK profile (acmecloudco.com);
# "Profile 1" = personal. window.open() from the app inherits THIS profile,
# so forcing it here routes all outbound links to work, not personal.
$profileDir = 'Default'
# If the PWA has been installed under $profileDir (run install-shortcut.ps1),
# its 32-char app id lands here so we open it as an installed app (crisp 512
# icon + groups under one taskbar button) instead of an ad-hoc --app window.
$appIdFile = Join-Path $root '.tsrct-appid'
$appId     = if (Test-Path $appIdFile) { (Get-Content $appIdFile -Raw).Trim() } else { '' }

function ConvertTo-WslPath([string]$p) {
    $p = $p -replace '\\','/'
    if ($p -match '^([A-Za-z]):(.*)$') { return "/mnt/$($matches[1].ToLower())$($matches[2])" }
    return $p
}
$wslDir = ConvertTo-WslPath $root

# --- helpers ----------------------------------------------------------------
function Test-Port([int]$p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(200)
        if ($ok -and $c.Connected) { $c.EndConnect($iar); $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}
function Read-Log {
    if (-not (Test-Path $logWin)) { return '' }
    try {
        $fs = [System.IO.File]::Open($logWin,'Open','Read','ReadWrite')
        $sr = New-Object System.IO.StreamReader($fs)
        $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close(); return $t
    } catch { return '' }
}
$esc = [char]27
function Clean-Line([string]$s) {
    $s = $s -replace "$esc\[[0-9;?]*[A-Za-z]", ''
    $s = $s -replace '[^\x20-\x7E]', ' '
    return $s.Trim()
}
# Readiness marker printed by server.js at the end of its listen callback.
# Was the cloudflared URL regex until 2026-08-11; the quick tunnel is retired, so
# keying the splash to it would have made every launch creep to the 45s fallback.
$readyRe = '\[READY\]'

# --- restart hand-off: let the old server exit first ------------------------
if ($WaitPortFree) {
    for ($i = 0; $i -lt 60 -and (Test-Port $port); $i++) { Start-Sleep -Milliseconds 250 }
}

# --- idempotency: already running? -----------------------------------------
$alreadyUp = Test-Port $port

# --- start the server (hidden) if not already up ----------------------------
if (-not $alreadyUp) {
    Set-Content -Path $logWin -Value '' -Encoding utf8 -ErrorAction SilentlyContinue
    $bootSh = "$wslDir/boot-server.sh"          # node resolution lives in the script
    Start-Process -FilePath 'wsl.exe' `
        -ArgumentList @('-d', $distro, '--', 'bash', $bootSh) `
        -WindowStyle Hidden | Out-Null
}

# ============================================================================
#  SPLASH  (owner-drawn: frame art + glowing title + real progress bar)
# ============================================================================
$neon  = [System.Drawing.Color]::FromArgb(0,255,65)
$cyan  = [System.Drawing.Color]::FromArgb(0,212,255)
$red   = [System.Drawing.Color]::FromArgb(255,60,90)
$black = [System.Drawing.Color]::FromArgb(6,10,6)

# load cover art without locking the file (clone into a Bitmap)
$img = $null
$artPath = if (Test-Path $splashPng) { $splashPng } elseif (Test-Path $logoPng) { $logoPng } else { $null }
if ($artPath) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($artPath)
        $ms = New-Object System.IO.MemoryStream(,$bytes)
        $tmp = [System.Drawing.Image]::FromStream($ms)
        $img = New-Object System.Drawing.Bitmap($tmp)
        $tmp.Dispose(); $ms.Dispose()
    } catch { $img = $null }
}

# window size from art aspect ratio (capped)
if ($img) {
    $maxW = 880
    $ratio = [double]$img.Height / [double]$img.Width
    $cw = [Math]::Min($maxW, $img.Width)
    $ch = [int]($cw * $ratio)
    if ($ch -gt 560) { $ch = 560; $cw = [int]($ch / $ratio) }
} else {
    $cw = 780; $ch = 300
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'CenterScreen'
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.BackColor       = $black
$form.ClientSize      = New-Object System.Drawing.Size($cw, $ch)
# double-buffer to kill flicker on repaint
$dbProp = [System.Windows.Forms.Control].GetProperty('DoubleBuffered',
    [System.Reflection.BindingFlags]'Instance,NonPublic')
$dbProp.SetValue($form, $true, $null)

# --- shared render/boot state ----------------------------------------------
$script:progress = 0.0     # displayed 0..1
$script:target   = 0.06    # eased-toward 0..1 (monotonic)
$script:statusTx = 'booting wsl'
$script:done     = $false
$script:result   = $null   # 'ready' | 'port' | 'error'
$script:tick     = 0
$start = Get-Date

# on-brand renderer (Orbitron/Exo2/JetBrainsMono + cyberpunk effects)
. (Join-Path $root 'splash-draw.ps1')
Init-SplashFonts $root

$form.Add_Paint({
    Draw-Splash $_.Graphics $cw $ch $img $script:progress $script:statusTx $script:tick ($script:result -eq 'error')
})

function Finish {
    if ($script:done) { return }
    $script:done = $true
    $poll.Stop()
    if ($script:result -eq 'error') {
        $script:statusTx = 'SERVER FAILED - see .tsrct-boot.log'
    } else {
        $script:target = 1.0; $script:statusTx = 'SYSTEM ONLINE'
        # let the bar fill to 100 before closing
        for ($i=0; $i -lt 30 -and $script:progress -lt 0.999; $i++) {
            $script:progress += (1.0 - $script:progress) * 0.35
            $form.Invalidate(); $form.Update(); Start-Sleep -Milliseconds 16
        }
        $script:progress = 1.0; $form.Invalidate(); $form.Update()
    }
    Start-Sleep -Milliseconds 600
    for ($o = 1.0; $o -gt 0; $o -= 0.1) { $form.Opacity = $o; Start-Sleep -Milliseconds 20 }
    $anim.Stop()
    $form.Close()
}

# animation timer: ease bar toward target + repaint
$anim = New-Object System.Windows.Forms.Timer
$anim.Interval = 33
$anim.Add_Tick({
    $script:tick++
    if (-not $script:done) {
        $script:progress += ($script:target - $script:progress) * 0.10
    }
    $form.Invalidate()
})
$anim.Start()

# poll timer: map real boot milestones -> progress target
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 400
$poll.Add_Tick({
    $elapsed = ((Get-Date) - $start).TotalSeconds
    $log = Read-Log
    $portOpen = Test-Port $port

    # live status text = last meaningful backend line
    if ($log) {
        $lines = $log -split "`n" | ForEach-Object { Clean-Line $_ } | Where-Object { $_ -ne '' }
        if ($lines.Count -gt 0) {
            $last = $lines[$lines.Count - 1]
            if ($last.Length -gt 58) { $last = $last.Substring(0,55) + '...' }
            $script:statusTx = $last
        }
    }

    # milestone -> target (monotonic)
    $t = 0.06
    if ($log -match '\[BOOT\]') { $t = 0.18 }
    if ($portOpen) { $t = 0.55 }
    if ($log -match 'warmup|project context ready|initial target|clickup') { $t = 0.72 }
    # honest idle creep while waiting for readiness (never reaches 100)
    if ($portOpen -and $log -notmatch $readyRe) {
        $creep = 0.55 + [Math]::Min(0.33, ($elapsed - 3) * 0.02)
        if ($creep -gt $t) { $t = $creep }
    }
    if ($log -match $readyRe) { $t = 1.0 }
    if ($t -gt $script:target) { $script:target = $t }

    # readiness
    if ($log -match $readyRe) { $script:result = 'ready'; Finish }
    elseif ($portOpen -and $elapsed -ge 45) { $script:result = 'port'; Finish }
    elseif ($elapsed -ge 100) {
        $script:result = if ($portOpen) { 'port' } else { 'error' }
        Finish
    }
})

# already running -> short brand flash then go; else poll for boot
if ($alreadyUp) {
    $script:statusTx = 'SYSTEM ALREADY ONLINE'; $script:target = 1.0
    $flash = New-Object System.Windows.Forms.Timer
    $flash.Interval = 1100
    $flash.Add_Tick({ $flash.Stop(); $script:result = 'port'; Finish })
    $flash.Start()
} else {
    $poll.Start()
}

$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()

# ============================================================================
#  OPEN THE APP  (standalone app-window when Chrome/Edge available)
# ============================================================================
if ($script:result -ne 'error') {
    $chrome = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    $edge = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    # Prefer the installed-PWA identity (--app-id): crisp 512 icon + a single
    # taskbar button that groups under the pinned launcher. Fall back to an
    # ad-hoc --app window if the PWA isn't installed yet. Either way, pin the
    # window to the WORK profile so outbound links don't leak to personal.
    $prof = "--profile-directory=$profileDir"
    try {
        if     ($chrome -and $appId) { Start-Process $chrome -ArgumentList $prof, "--app-id=$appId" }
        elseif ($chrome)             { Start-Process $chrome -ArgumentList $prof, "--app=$url" }
        elseif ($edge)               { Start-Process $edge   -ArgumentList $prof, "--app=$url" }
        else                         { Start-Process $url }
    } catch { Start-Process $url }
}
