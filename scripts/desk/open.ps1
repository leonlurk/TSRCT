# open.ps1 - the PC without the mouse (lib/pcDirect.js runs this).
#
#   -Target <path or https URL>   open it in Windows' default program
#   -Reveal <path>                open its folder with the file selected
#   -App <name>                   launch an app from the Start menu's own list
#                                 (Get-StartApps), printing "L|<name>"; nothing
#                                 is printed when no app matches
#
# Arguments arrive through -File, so a path is never parsed as code.
param([string]$Target = '', [string]$Reveal = '', [string]$App = '')
$ErrorActionPreference = 'Stop'
if ($Target) {
    Start-Process -FilePath $Target
} elseif ($Reveal) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$Reveal`""
} elseif ($App) {
    # Exact name first, then the shortest name that contains it ("excel" -> Excel,
    # not "Excel Viewer Legacy").
    $apps = Get-StartApps | Where-Object { $_.Name -like "*$App*" }
    $hit = ($apps | Where-Object { $_.Name -eq $App } | Select-Object -First 1)
    if (-not $hit) { $hit = $apps | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
    if ($hit) {
        Start-Process -FilePath "shell:AppsFolder\$($hit.AppID)"
        "L|$($hit.Name)"
    }
}
