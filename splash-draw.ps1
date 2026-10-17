# ============================================================================
#  Shared splash renderer (dot-sourced by launch-tsrct.ps1 and render-preview.ps1)
#  On-brand treatment grounded in ui-ux-pro-max design intelligence:
#   - style #11 Retro-Futurism (cyberpunk): neon glow, CRT scanlines, chromatic
#   - type pairing #36 Crypto/Web3: Orbitron (display) + Exo 2 (body)
#   - type pairing #9  Developer Mono: JetBrains Mono (terminal readout)
#  Fonts loaded from ./fonts via PrivateFontCollection (no system install).
# ============================================================================
Add-Type -AssemblyName System.Drawing

$script:SPFC   = $null
$script:SPFams = @{}

function Init-SplashFonts([string]$root) {
    if ($script:SPFC) { return }
    $script:SPFC = New-Object System.Drawing.Text.PrivateFontCollection
    foreach ($f in 'Orbitron.ttf','Exo2.ttf','JetBrainsMono.ttf') {
        $p = Join-Path $root "fonts\$f"
        if (Test-Path $p) { try { $script:SPFC.AddFontFile($p) } catch {} }
    }
    foreach ($fam in $script:SPFC.Families) { $script:SPFams[$fam.Name] = $fam }
}
function New-PFont([string]$name, [single]$size, [System.Drawing.FontStyle]$style = 'Regular') {
    $fam = $script:SPFams[$name]
    if ($fam) { return New-Object System.Drawing.Font($fam, $size, $style, 'Pixel') }
    return New-Object System.Drawing.Font('Consolas', $size, $style, 'Pixel')
}

# typographic string format (tight metrics)
$script:SPtf = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$script:SPtf.FormatFlags = $script:SPtf.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces

# Draw a centered, letter-tracked string. Deterministic layout so repeated
# calls (glow / chromatic / crisp passes) align pixel-perfect. Returns width.
function Draw-Tracked($g, [string]$text, $font, $brush, [single]$cx, [single]$y, [single]$track, [single]$ox = 0, [single]$oy = 0) {
    $widths = @(); $total = 0
    foreach ($chr in $text.ToCharArray()) {
        $w = $g.MeasureString([string]$chr, $font, 1000, $script:SPtf).Width
        $widths += $w; $total += $w
    }
    $total += $track * ($text.Length - 1)
    $x = $cx - ($total / 2)
    for ($i = 0; $i -lt $text.Length; $i++) {
        $g.DrawString([string]$text[$i], $font, $brush, ($x + $ox), ($y + $oy), $script:SPtf)
        $x += $widths[$i] + $track
    }
    return $total
}

function Draw-Splash($g, [int]$cw, [int]$ch, $img, [double]$progress, [string]$statusTx, [int]$tick, [bool]$isError) {
    $g.SmoothingMode     = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.InterpolationMode = 'HighQualityBicubic'

    $neon = [System.Drawing.Color]::FromArgb(0,255,65)
    $cyan = [System.Drawing.Color]::FromArgb(0,225,255)
    $pink = [System.Drawing.Color]::FromArgb(255,40,120)
    $acc  = if ($isError) { [System.Drawing.Color]::FromArgb(255,60,90) } else { $neon }

    if ($img) { $g.DrawImage($img, 0, 0, $cw, $ch) } else { $g.Clear([System.Drawing.Color]::FromArgb(6,10,6)) }

    # --- CRT scanlines (subtle) ---
    $scan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26,0,0,0))
    for ($yy = 0; $yy -lt $ch; $yy += 3) { $g.FillRectangle($scan, 0, $yy, $cw, 1) }
    $scan.Dispose()

    $cxF = $cw / 2.0

    # --- TITLE: Orbitron Black, tracked, chromatic aberration + neon glow ---
    $tSize = [int]($ch * 0.125)
    $fT = New-PFont 'Orbitron Black' $tSize
    $titleY = [single]($ch * 0.245)
    $trk = [single]($tSize * 0.14)
    # glow ring
    $glowB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(48,$acc.R,$acc.G,$acc.B))
    foreach ($o in @(@(-3,0),@(3,0),@(0,-3),@(0,3),@(-2,-2),@(2,2),@(-2,2),@(2,-2))) {
        [void](Draw-Tracked $g 'TSRCT' $fT $glowB $cxF $titleY $trk $o[0] $o[1])
    }
    $glowB.Dispose()
    # chromatic fringes
    $cyB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150,$cyan.R,$cyan.G,$cyan.B))
    $pkB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120,$pink.R,$pink.G,$pink.B))
    [void](Draw-Tracked $g 'TSRCT' $fT $cyB $cxF $titleY $trk  2.2 0)
    [void](Draw-Tracked $g 'TSRCT' $fT $pkB $cxF $titleY $trk -2.2 0)
    $cyB.Dispose(); $pkB.Dispose()
    # crisp
    $crisp = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,$acc.R,$acc.G,$acc.B))
    $titleW = Draw-Tracked $g 'TSRCT' $fT $crisp $cxF $titleY $trk 0 0
    $crisp.Dispose(); $fT.Dispose()

    # --- HUD divider under title (line with center gap + end ticks) ---
    $dy = [int]($ch * 0.455)
    $dw = [int]([Math]::Min($titleW * 1.05, $cw * 0.66))
    $dx1 = [int]($cxF - $dw/2); $dx2 = [int]($cxF + $dw/2); $gap = 26
    $dpen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150,$acc.R,$acc.G,$acc.B)), 1
    $g.DrawLine($dpen, $dx1, $dy, ([int]$cxF - $gap), $dy)
    $g.DrawLine($dpen, ([int]$cxF + $gap), $dy, $dx2, $dy)
    $g.DrawLine($dpen, $dx1, ($dy-3), $dx1, ($dy+3))     # end ticks
    $g.DrawLine($dpen, $dx2, ($dy-3), $dx2, ($dy+3))
    $dpen.Dispose()
    # small centered diamond in the gap
    $dia = New-Object System.Drawing.SolidBrush $cyan
    $g.FillPolygon($dia, @(
        (New-Object System.Drawing.Point([int]$cxF, ($dy-4))),
        (New-Object System.Drawing.Point(([int]$cxF+4), $dy)),
        (New-Object System.Drawing.Point([int]$cxF, ($dy+4))),
        (New-Object System.Drawing.Point(([int]$cxF-4), $dy))))
    $dia.Dispose()

    # --- SUBTITLE: Exo 2 SemiBold, tracked, cyan ---
    $fS = New-PFont 'Exo 2 SemiBold' ([int]($ch*0.033))
    $subB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210,$cyan.R,$cyan.G,$cyan.B))
    [void](Draw-Tracked $g 'TESSERACT REMOTE CONTROL TERMINAL' $fS $subB $cxF ([single]($ch*0.485)) 3.0)
    $subB.Dispose(); $fS.Dispose()

    # --- PROGRESS BAR: segmented HUD ---
    $bw = [int]($cw*0.50); $bx = [int]($cxF - $bw/2); $by = [int]($ch*0.64); $bh = 10
    $prog = [Math]::Min(1.0, [Math]::Max(0.0, $progress))
    $fw = [int]($bw * $prog)
    # track
    $tb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120,6,16,8)); $g.FillRectangle($tb,$bx,$by,$bw,$bh); $tb.Dispose()
    # fill glow + fill
    if ($fw -gt 0) {
        $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70,$acc.R,$acc.G,$acc.B)); $g.FillRectangle($fg,($bx-1),($by-2),($fw+2),($bh+4)); $fg.Dispose()
        $fb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235,$acc.R,$acc.G,$acc.B)); $g.FillRectangle($fb,$bx,$by,$fw,$bh); $fb.Dispose()
        $cap = New-Object System.Drawing.SolidBrush $cyan; $g.FillRectangle($cap,($bx+$fw-2),($by-1),3,($bh+2)); $cap.Dispose()
    }
    # segment ticks every 10%
    $seg = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90,0,0,0)), 1
    for ($s=1; $s -lt 10; $s++) { $sx=[int]($bx + $bw*$s/10.0); $g.DrawLine($seg,$sx,($by+1),$sx,($by+$bh-1)) }
    $seg.Dispose()
    # border
    $bp = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(180,$acc.R,$acc.G,$acc.B)), 1; $g.DrawRectangle($bp,$bx,$by,$bw,$bh); $bp.Dispose()

    # --- PERCENT (JetBrains Mono) right of bar-ish, centered under ---
    $fM = New-PFont 'JetBrains Mono' ([int]($ch*0.028))
    $pct = [int]([Math]::Min(100, $prog*100))
    $pctStr = ('{0,3}%' -f $pct)
    $pcf = New-Object System.Drawing.StringFormat; $pcf.Alignment='Center'
    $pb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,$acc.R,$acc.G,$acc.B))
    $g.DrawString($pctStr, $fM, $pb, (New-Object System.Drawing.RectangleF(0,($by+$bh+5),$cw,20)), $pcf); $pb.Dispose()

    # --- STATUS line (JetBrains Mono) with blinking cursor block ---
    $fSt = New-PFont 'JetBrains Mono' ([int]($ch*0.021))
    $cur = if (($tick % 20) -lt 10) { [char]0x2588 } else { ' ' }
    $txt = "> $statusTx $cur"
    $stb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200,$acc.R,$acc.G,$acc.B))
    $g.DrawString($txt, $fSt, $stb, (New-Object System.Drawing.RectangleF(0,($by+$bh+26),$cw,16)), $pcf); $stb.Dispose()
    $fM.Dispose(); $fSt.Dispose()
}
