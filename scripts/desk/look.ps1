# look.ps1 - Tesla's eyes on the Windows desktop (lib/desk.js runs this).
#
# Captures each monitor to a STAGED png and reads its text with Windows' own
# OCR, so lib/desk.js can refuse a screen that shows SecretCo BEFORE any model
# sees it. The OCR text never leaves this machine: it is printed base64 for
# lib/desk.js to check and is then thrown away.
#
# Output, one record per line:
#   T|<window title>                         every visible top-level window
#   S|<label>|<x>|<y>|<w>|<h>|<file>|<b64>   one per captured monitor
#
# OCR runs at 2x: measured 2026-10-10, 7pt Consolas in a dark terminal is
# missed at 1x and read at 2x (8pt and up is read at both).
param([string]$Dir, [string]$Stamp, [int]$Screen = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Runtime.WindowsRuntime
# PER-MONITOR aware, or Bounds and CopyFromScreen disagree on a monitor whose
# scaling differs from the main one (measured: the 2nd monitor came out shifted,
# a third of it blank). -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TsrctDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
if (-not [TsrctDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [TsrctDpi]::SetProcessDPIAware() | Out-Null }
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

# en-US is the one recognizer installed here (es-AR has none); "SecretCo" reads the same.
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
if (-not $engine) { throw 'no OCR engine (en-US recognizer missing)' }

function Read-Text([System.Drawing.Bitmap]$bmp, [string]$tmp) {
    $f = [Math]::Min(2.0, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [Math]::Max($bmp.Width, $bmp.Height))
    $big = New-Object System.Drawing.Bitmap ([int]($bmp.Width * $f)), ([int]($bmp.Height * $f))
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
    $g.Dispose()
    $big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $big.Dispose()
    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $soft = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $r = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
        $stream.Dispose()
        return [string]$r.Text
    } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

# Where the cursor is: lib/desk.js compares it before each act to know whether
# Leon took the mouse back.
$c = [System.Windows.Forms.Cursor]::Position
"C|$($c.X)|$($c.Y)"

Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "T|$($_.ProcessName): $($_.MainWindowTitle -replace '[\r\n|]', ' ')" }

# Same order and labels as server.js readWindowsScreens: by DISPLAY number, then 1..N.
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object {
    if ($_.DeviceName -match '(\d+)\s*$') { [int]$Matches[1] } else { 99 } }
$i = 0
foreach ($s in $screens) {
    $i++
    if ($Screen -gt 0 -and $Screen -ne $i) { continue }
    $b = $s.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
    $g.Dispose()
    $out = Join-Path $Dir "$Stamp-$i.staged.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $text = Read-Text $bmp (Join-Path $Dir "$Stamp-$i.ocr.png")
    $bmp.Dispose()
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    "S|$i|$($b.X)|$($b.Y)|$($b.Width)|$($b.Height)|$out|$b64"
}
