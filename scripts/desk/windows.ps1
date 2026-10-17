# windows.ps1 - Tesla arranges windows without the mouse (lib/deskWindows.js runs this).
#
#   -Op list            M|<n>|<device>|<bx>,<by>,<bw>,<bh>|<wx>,<wy>,<ww>,<wh>|<primary 0/1>   one per monitor
#                       W|<hwnd>|<process>|<title>|<x>,<y>,<w>,<h>|<monitor n>|<normal|max|min>   one per window, front first
#   -Op apply -Text <b64 JSON [{match|hwnd, x,y,w,h, state, front}]>
#                       P|ok|<process>|<title>|<x>,<y>,<w>,<h>   or  P|none|<match>   or  P|deny|<title>
#   -Op solo  -Text <b64 JSON {keep:[names]}>   minimizes every other visible window: S|<count>
#
# Monitors are numbered like look.ps1 (by DISPLAY number), so "screen 2" is the
# same monitor everywhere. Rects are the VISIBLE frame in physical pixels: the
# invisible resize border Windows 11 adds (DWMWA_EXTENDED_FRAME_BOUNDS) is
# compensated, or every placed window would sit 7 px off its slot.
# -Deny is lib/desk.js's SecretCo-work pattern: a window that matches it is never touched.
param([string]$Op, [string]$Text = '', [string]$Deny = '')
$ErrorActionPreference = 'Stop'
# Titles carry accents ("Facturacion" came out with a ? in it): UTF-8 out, read as UTF-8 by Node.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TsrctWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, IntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }
    // What a person sees in Alt+Tab: visible, titled, not a tool window, not
    // owned by another window, not cloaked (a UWP app suspended in the background).
    public static List<IntPtr> Visible() {
        var list = new List<IntPtr>();
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            if (Title(h).Length == 0) return true;
            int ex = GetWindowLong(h, -20);
            if ((ex & 0x80) != 0) return true;                 // WS_EX_TOOLWINDOW
            if (GetWindow(h, 4) != IntPtr.Zero) return true;   // GW_OWNER
            int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }
    // The visible frame, without the invisible resize border.
    public static RECT Frame(IntPtr h) {
        RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) == 0) return r;
        GetWindowRect(h, out r); return r;
    }
    public static void Place(IntPtr h, int x, int y, int w, int hh) {
        if (IsIconic(h) || IsZoomed(h)) { ShowWindow(h, 9); Thread.Sleep(120); }
        // Twice, measuring the border each time: a move ACROSS monitors with
        // different scaling resizes the window and its invisible border on
        // arrival (WM_DPICHANGED; measured 2 px off), so the second call lands it.
        for (int i = 0; i < 2; i++) {
            RECT outer; GetWindowRect(h, out outer);
            RECT vis = Frame(h);
            int dl = vis.L - outer.L, dt = vis.T - outer.T, dr = outer.R - vis.R, db = outer.B - vis.B;
            SetWindowPos(h, IntPtr.Zero, x - dl, y - dt, w + dl + dr, hh + dt + db, 0x0004 | 0x0010);   // NOZORDER | NOACTIVATE
            Thread.Sleep(60);
        }
    }
    public static void Front(IntPtr h) {
        keybd_event(0x12, 0, 0, IntPtr.Zero); keybd_event(0x12, 0, 2, IntPtr.Zero);   // Alt tap: the foreground lock
        SetForegroundWindow(h);
    }
}
'@
[TsrctWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object {
    if ($_.DeviceName -match '(\d+)\s*$') { [int]$Matches[1] } else { 99 } }
function MonitorOf([TsrctWin+RECT]$r) {
    $cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
    $i = 0
    foreach ($s in $screens) { $i++; if ($s.Bounds.Contains($cx, $cy)) { return $i } }
    return 0
}
function Clean([string]$s) { return ($s -replace '[\r\n|]', ' ') }
function Label([IntPtr]$h) { return "$([TsrctWin]::Proc($h)): $([TsrctWin]::Title($h))" }
function Find([string]$want, $all) {
    $want = $want.Trim()
    # The process name first (the app), then the title; front-most first (EnumWindows is z-order).
    $hit = $all | Where-Object { [TsrctWin]::Proc($_) -like "*$want*" } | Select-Object -First 1
    if (-not $hit) { $hit = $all | Where-Object { [TsrctWin]::Title($_) -like "*$want*" } | Select-Object -First 1 }
    return $hit
}

switch ($Op) {
    'list' {
        $i = 0
        foreach ($s in $screens) {
            $i++; $b = $s.Bounds; $w = $s.WorkingArea
            "M|$i|$($s.DeviceName)|$($b.X),$($b.Y),$($b.Width),$($b.Height)|$($w.X),$($w.Y),$($w.Width),$($w.Height)|$([int]$s.Primary)"
        }
        foreach ($h in [TsrctWin]::Visible()) {
            $r = [TsrctWin]::Frame($h)
            $state = if ([TsrctWin]::IsIconic($h)) { 'min' } elseif ([TsrctWin]::IsZoomed($h)) { 'max' } else { 'normal' }
            "W|$h|$([TsrctWin]::Proc($h))|$(Clean ([TsrctWin]::Title($h)))|$($r.L),$($r.T),$($r.R - $r.L),$($r.B - $r.T)|$(MonitorOf $r)|$state"
        }
    }
    'apply' {
        $moves = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text)) | ConvertFrom-Json
        $all = [TsrctWin]::Visible()
        foreach ($m in @($moves)) {
            $h = if ($m.hwnd) { [IntPtr][long]$m.hwnd } else { Find ([string]$m.match) $all }
            if (-not $h) { "P|none|$(Clean ([string]$m.match))"; continue }
            $label = Label $h
            if ($Deny -and $label -match $Deny) { "P|deny|$(Clean $label)"; continue }
            switch ([string]$m.state) {
                'min' { [TsrctWin]::ShowWindow($h, 6) | Out-Null }
                'max' {
                    # Onto the right monitor first, then maximize there.
                    if ($m.w) { [TsrctWin]::Place($h, [int]$m.x, [int]$m.y, [int]$m.w, [int]$m.h) }
                    [TsrctWin]::ShowWindow($h, 3) | Out-Null
                }
                'restore' { [TsrctWin]::ShowWindow($h, 9) | Out-Null }
                # Brought forward below as it is; a minimized one is restored first,
                # or the keys meant for it go to a window nobody can see.
                'front' { if ([TsrctWin]::IsIconic($h)) { [TsrctWin]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 150 } }
                default { [TsrctWin]::Place($h, [int]$m.x, [int]$m.y, [int]$m.w, [int]$m.h) }
            }
            if ($m.front -and [string]$m.state -ne 'min') { [TsrctWin]::Front($h) }
            Start-Sleep -Milliseconds 80
            $r = [TsrctWin]::Frame($h)
            "P|ok|$([TsrctWin]::Proc($h))|$(Clean ([TsrctWin]::Title($h)))|$($r.L),$($r.T),$($r.R - $r.L),$($r.B - $r.T)"
        }
    }
    'solo' {
        $o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text)) | ConvertFrom-Json
        $keep = @($o.keep | ForEach-Object { [string]$_ })
        $n = 0
        foreach ($h in [TsrctWin]::Visible()) {
            if ([TsrctWin]::IsIconic($h)) { continue }
            $label = Label $h
            if ($keep | Where-Object { $_ -and $label -like "*$_*" }) { continue }
            if ($Deny -and $label -match $Deny) { continue }
            [TsrctWin]::ShowWindow($h, 6) | Out-Null
            $n++
        }
        "S|$n"
    }
    default { throw "unknown op: $Op" }
}
