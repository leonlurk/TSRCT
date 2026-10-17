# act.ps1 - Tesla's hands on the Windows desktop (lib/desk.js runs this).
#
# One input per run: click / double / right / move / scroll / drag (-X2 -Y2 the drop point) at ABSOLUTE
# physical coordinates, type a text (base64, sent as unicode so accents and
# symbols arrive as written, never through the clipboard - his clipboard is his),
# or press a key combination ("ctrl+s", "win", "alt+tab").
#
# -Op probe only reports, which is what lib/desk.js asks BEFORE it acts, to
# know whether he moved the mouse and what window has the focus.
#
# -Op focus -Text <base64 name>: the first window whose process or title contains
# the name is restored and brought forward (N| when none matches). The Deny
# check is on THAT window, before it is touched.
#
# Output: C|<cursor x>|<cursor y>   F|<process>: <foreground window title>
#
# Two refusals happen HERE, in the same run, so nothing changes between the
# check and the act: the cursor is not where Tesla left it (-ExpectX/-ExpectY:
# Leon moved the mouse, he has the wheel) -> "H|x|y" and nothing is done; the
# window in front matches -Deny (lib/desk.js builds it) -> "D|title", nothing done.
param([string]$Op, [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0, [string]$Text = '', [string]$Keys = '', [int]$Amount = 0, [int]$Times = 1,
      [int]$ExpectX = -99999, [int]$ExpectY = -99999, [string]$Deny = '')
$ErrorActionPreference = 'Stop'
# The window title in F| carries accents ("Inscricao" came out with a ? in it).
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public class TsrctHands {
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    // Restore it if minimized, then bring it forward. Windows refuses
    // SetForegroundWindow to a process that did not get the last input; a tap
    // of Alt first is the documented way around that lock.
    public static void Raise(IntPtr h) {
        if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
        Send(new[] { K(0x12, 0, 0), K(0x12, 0, KUP) });
        SetForegroundWindow(h);
        Thread.Sleep(350);
    }
    const uint MOUSE = 0, KEY = 1;
    const uint LDOWN = 2, LUP = 4, RDOWN = 8, RUP = 16, WHEEL = 0x800;
    const uint KUP = 2, UNICODE = 4;
    static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
    static INPUT M(uint f, uint data) { var i = new INPUT(); i.type = MOUSE; i.u.mi.dwFlags = f; i.u.mi.mouseData = data; return i; }
    static INPUT K(ushort vk, ushort scan, uint f) { var i = new INPUT(); i.type = KEY; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = f; return i; }
    public static void Move(int x, int y) { SetCursorPos(x, y); Thread.Sleep(60); }
    public static void Click(int x, int y, bool right, int times) {
        Move(x, y);
        for (int t = 0; t < times; t++) {
            Send(new[] { M(right ? RDOWN : LDOWN, 0), M(right ? RUP : LUP, 0) });
            Thread.Sleep(70);
        }
    }
    public static void Scroll(int x, int y, int notches) { Move(x, y); Send(new[] { M(WHEEL, (uint)(notches * 120)) }); }
    // Press, travel, release (2026-10-11: the Lightning App Builder only takes a
    // field by drag-and-drop). The travel is in small steps with pauses, because
    // HTML5 drag-and-drop in Chrome only starts after the pointer moves a few
    // pixels with the button held, and the drop target lights up only when the
    // pointer has hovered over it for a moment before the release.
    public static void Drag(int x, int y, int x2, int y2) {
        Move(x, y);
        Send(new[] { M(LDOWN, 0) });
        Thread.Sleep(200);
        SetCursorPos(x + 6, y + 6); Thread.Sleep(120);
        const int steps = 25;
        for (int i = 1; i <= steps; i++) {
            SetCursorPos(x + (x2 - x) * i / steps, y + (y2 - y) * i / steps);
            Thread.Sleep(25);
        }
        Thread.Sleep(400);
        Send(new[] { M(LUP, 0) });
        Thread.Sleep(150);
    }
    public static void Type(string s) {
        foreach (char c in s.Replace("\r\n", "\n")) {
            if (c == '\n') { Send(new[] { K(0x0D, 0, 0), K(0x0D, 0, KUP) }); }
            else if (c == '\t') { Send(new[] { K(0x09, 0, 0), K(0x09, 0, KUP) }); }
            else { Send(new[] { K(0, c, UNICODE), K(0, c, UNICODE | KUP) }); }
            Thread.Sleep(8);
        }
    }
    public static void Combo(ushort[] vks) {
        foreach (var v in vks) { Send(new[] { K(v, 0, 0) }); Thread.Sleep(30); }
        for (int i = vks.Length - 1; i >= 0; i--) { Send(new[] { K(vks[i], 0, KUP) }); Thread.Sleep(30); }
    }
    public static string Foreground() {
        IntPtr h = GetForegroundWindow();
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
        return name + ": " + sb.ToString();
    }
}
'@
# Same coordinate space as look.ps1: per-monitor physical pixels.
[TsrctHands]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$VK = @{
    ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; windows = 0x5B;
    enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; backspace = 0x08; delete = 0x2E; del = 0x2E;
    space = 0x20; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23;
    pageup = 0x21; pagedown = 0x22; insert = 0x2D; printscreen = 0x2C;
    # Named shortcuts (lib/deskShortcuts.js, 2026-10-11): Win+. emojis, Ctrl+` VS Code's terminal.
    period = 0xBE; comma = 0xBC; minus = 0xBD; plus = 0xBB; backtick = 0xC0;
    # Media keys (Tesla review #11: "volumeup" was unknown and the volume took a minute of clicks).
    volumeup = 0xAF; volumedown = 0xAE; volumemute = 0xAD;
    playpause = 0xB3; nexttrack = 0xB0; prevtrack = 0xB1; mediastop = 0xB2
}
$MEDIA = @('volumeup','volumedown','volumemute','playpause','nexttrack','prevtrack','mediastop')
function Vk([string]$k) {
    $k = $k.Trim().ToLower()
    if ($VK.ContainsKey($k)) { return [uint16]$VK[$k] }
    if ($k -match '^f([1-9]|1[0-2])$') { return [uint16](0x6F + [int]$Matches[1]) }
    if ($k -match '^[a-z0-9]$') { return [uint16][int][char]$k.ToUpper() }
    throw "unknown key: $k"
}

$p = New-Object TsrctHands+POINT
[TsrctHands]::GetCursorPos([ref]$p) | Out-Null
if ($ExpectX -ne -99999 -and ([Math]::Abs($p.X - $ExpectX) -gt 6 -or [Math]::Abs($p.Y - $ExpectY) -gt 6)) {
    "H|$($p.X)|$($p.Y)"
    exit 0
}
$front = [TsrctHands]::Foreground()
if ($Op -ne 'focus' -and $Op -ne 'media' -and $Deny -and $front -match $Deny) {
    "D|$($front -replace '[\r\n|]', ' ')"
    exit 0
}

switch ($Op) {
    'probe'  { }
    'move'   { [TsrctHands]::Move($X, $Y) }
    'click'  { [TsrctHands]::Click($X, $Y, $false, 1) }
    'double' { [TsrctHands]::Click($X, $Y, $false, 2) }
    'right'  { [TsrctHands]::Click($X, $Y, $true, 1) }
    'scroll' { [TsrctHands]::Scroll($X, $Y, $Amount) }
    'drag'   { [TsrctHands]::Drag($X, $Y, $X2, $Y2) }
    'type'   { [TsrctHands]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text))) }
    'key'    { [TsrctHands]::Combo([uint16[]]@($Keys -split '\+' | ForEach-Object { Vk $_ })) }
    'media'  {
        if ($MEDIA -notcontains $Keys) { throw "not a media key: $Keys" }
        for ($i = 0; $i -lt [Math]::Max(1, [Math]::Min(60, $Times)); $i++) { [TsrctHands]::Combo([uint16[]]@((Vk $Keys))); Start-Sleep -Milliseconds 15 }
    }
    'focus'  {
        $want = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text)).Trim()
        $win = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$want*" -or $_.MainWindowTitle -like "*$want*") } |
            Sort-Object @{ Expression = { if ($_.ProcessName -like "*$want*") { 0 } else { 1 } } } | Select-Object -First 1
        if (-not $win) { "N|$want"; exit 0 }
        $label = "$($win.ProcessName): $($win.MainWindowTitle)"
        if ($Deny -and $label -match $Deny) { "D|$($label -replace '[\r\n|]', ' ')"; exit 0 }
        [TsrctHands]::Raise($win.MainWindowHandle)
    }
    default  { throw "unknown op: $Op" }
}
Start-Sleep -Milliseconds 120
$p = New-Object TsrctHands+POINT
[TsrctHands]::GetCursorPos([ref]$p) | Out-Null
"C|$($p.X)|$($p.Y)"
"F|$(([TsrctHands]::Foreground()) -replace '[\r\n|]', ' ')"
