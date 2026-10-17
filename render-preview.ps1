# Static preview of the splash overlay (uses the shared splash-draw.ps1 module)
# so we can eyeball the on-brand typography/effects without a live boot.
Add-Type -AssemblyName System.Drawing
$root = $PSScriptRoot
. (Join-Path $root 'splash-draw.ps1')
Init-SplashFonts $root

$src = Join-Path $root 'splash.png'
$out = Join-Path $root 'splash-preview.png'
$progress = 0.68
$statusTx = 'dispatcher: hermes warmup: ok'

$bytes = [System.IO.File]::ReadAllBytes($src)
$ms = New-Object System.IO.MemoryStream(,$bytes)
$tmp = [System.Drawing.Image]::FromStream($ms)
$img = New-Object System.Drawing.Bitmap($tmp); $tmp.Dispose(); $ms.Dispose()

$maxW = 880
$ratio = [double]$img.Height / [double]$img.Width
$cw = [Math]::Min($maxW, $img.Width)
$ch = [int]($cw * $ratio)
if ($ch -gt 560) { $ch = 560; $cw = [int]($ch / $ratio) }

$bmp = New-Object System.Drawing.Bitmap($cw, $ch)
$g = [System.Drawing.Graphics]::FromImage($bmp)
Draw-Splash $g $cw $ch $img $progress $statusTx 0 $false
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "[+] preview -> $out  (${cw}x${ch})"
