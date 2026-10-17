# =============================================================================
#  TSRCT — bind TightVNC to loopback only.   REQUIRES ELEVATION (UAC).
#
#  Run:      powershell -ExecutionPolicy Bypass -File scripts\vnc-loopback.ps1
#  Undo:     powershell -ExecutionPolicy Bypass -File scripts\vnc-loopback.ps1 -Revert
#
#  WHY
#  TightVNC listens on 0.0.0.0 with a firewall rule allowing the Any profile, so
#  the desktop is reachable from the whole LAN — every device on the network, the
#  guest wifi, anything that joins it. TSRCT does not need that: WSL2 runs in
#  mirrored networking mode, so the server reaches TightVNC over 127.0.0.1
#  (see resolveVNCHost(), DOCUMENTATION.md gotcha 5). Binding to loopback removes
#  the entire LAN surface at zero cost to TSRCT.
#
#  This is also the real answer to "the VNC password was committed to git":
#  rotating it treats the symptom, this removes the surface where it would matter.
#  (2026-08-15 — the password had been readable in a private repo with a second
#  collaborator since 2026-05-06. Rotating is still worth doing, but it is
#  secondary to this.)
#
#  TRADE-OFF, decide before running: if you ever connect to this VNC from another
#  machine on the LAN *directly*, without going through TSRCT, this breaks that.
#  If you always go through TSRCT — which is the design — you lose nothing.
#
#  SAFETY: the script verifies the OUTCOME (what the port is actually bound to)
#  rather than trusting the setting, and AUTO-REVERTS if TightVNC comes back not
#  listening at all. It refuses to run while a VNC client is connected.
# =============================================================================
[CmdletBinding()]
param([switch]$Revert)

$ErrorActionPreference = 'Stop'
$KEY = 'HKLM:\SOFTWARE\TightVNC\Server'
$SVC = 'tvnserver'

function Assert-Elevated {
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "This must run elevated -- the TightVNC key is ACL'd (it holds the password hash)." -ForegroundColor Red
        exit 1
    }
}

function Get-Listeners {
    @(Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalAddress)
}

function Show-State([string]$label) {
    $l = Get-Listeners
    if ($l.Count -eq 0) { Write-Host ("  {0,-8} port 5900: NOT LISTENING" -f $label) -ForegroundColor Yellow }
    else { Write-Host ("  {0,-8} port 5900 bound to: {1}" -f $label, ($l -join ', ')) }
    return $l
}

Assert-Elevated

if (-not (Test-Path $KEY)) { Write-Host "TightVNC server key not found at $KEY" -ForegroundColor Red; exit 1 }

# Never yank the service out from under a live session.
$active = @(Get-NetTCPConnection -LocalPort 5900 -ErrorAction SilentlyContinue | Where-Object State -ne 'Listen')
if ($active.Count -gt 0) {
    Write-Host "A VNC client is connected right now ($($active[0].RemoteAddress)). Disconnect it first." -ForegroundColor Red
    exit 1
}

$before = Show-State 'BEFORE'

if ($Revert) {
    Write-Host "`nReverting: TightVNC will accept connections on all interfaces again."
    New-ItemProperty -Path $KEY -Name 'LoopbackOnly' -PropertyType DWord -Value 0 -Force | Out-Null
} else {
    Write-Host "`nSetting AllowLoopback=1, LoopbackOnly=1"
    # AllowLoopback must be on too, or LoopbackOnly leaves nothing that can connect.
    New-ItemProperty -Path $KEY -Name 'AllowLoopback' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $KEY -Name 'LoopbackOnly'  -PropertyType DWord -Value 1 -Force | Out-Null
}

Restart-Service $SVC
Start-Sleep -Seconds 3
$after = Show-State 'AFTER'

# Verify the outcome, do not trust the setting.
if ($after.Count -eq 0) {
    Write-Host "`nTightVNC came back NOT LISTENING -- reverting so remote desktop keeps working." -ForegroundColor Red
    New-ItemProperty -Path $KEY -Name 'LoopbackOnly' -PropertyType DWord -Value 0 -Force | Out-Null
    Restart-Service $SVC
    Start-Sleep -Seconds 3
    Show-State 'REVERTED' | Out-Null
    Write-Host "No change was kept. The value names may differ on this TightVNC build." -ForegroundColor Yellow
    exit 1
}

$lanExposed = @($after | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne '::1' }).Count -gt 0

if ($Revert) {
    Write-Host "`nReverted." -ForegroundColor Yellow
} elseif ($lanExposed) {
    Write-Host "`nStill bound to a non-loopback address. This TightVNC build may not honour" -ForegroundColor Yellow
    Write-Host "LoopbackOnly; fall back to scoping the firewall rule to 127.0.0.1 instead:" -ForegroundColor Yellow
    Write-Host "  Set-NetFirewallRule -DisplayName TightVNC -RemoteAddress 127.0.0.1" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "`nDone. TightVNC is loopback-only; the LAN can no longer reach it." -ForegroundColor Green
    Write-Host "TSRCT is unaffected -- it connects over 127.0.0.1 from WSL (mirrored networking)."
    Write-Host "Open the remote desktop room once to confirm, then the committed VNC password"
    Write-Host "only matters to something already running on this machine."
}
