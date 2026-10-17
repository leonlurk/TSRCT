# ============================================================================
#  TSRCT shortcut installer  (one-click launch, grouped taskbar, work profile)
# ----------------------------------------------------------------------------
#  Run once (after installing the PWA -- see the printed steps):
#      powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
#
#  What it does:
#   1. Creates/refreshes the Desktop "TSRCT" shortcut -> wscript TSRCT.vbs
#      (boots WSL + server + splash, then opens the app).
#   2. Uses the crisp multi-size logo.ico.
#   3. If the TSRCT PWA is installed under the WORK Chrome profile, it reads
#      that PWA's AppUserModelID and STAMPS it onto the launcher shortcut, so
#      the app window and the launcher share ONE taskbar button (no more
#      "second box"), and writes the app id to .tsrct-appid so the launcher
#      opens the installed PWA (crisp 512 icon) instead of an ad-hoc window.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root       = $PSScriptRoot
$vbs        = Join-Path $root 'TSRCT.vbs'
$ico        = Join-Path $root 'logo.ico'
$appIdFile  = Join-Path $root '.tsrct-appid'
$profileDir = 'Default'                       # WORK profile (acmecloudco.com)
$expectedId = 'nhpnefmchnlkaochigibcheolkicphjl'   # Chrome-assigned app id for the TSRCT PWA (Default profile)
$desktop    = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktop 'TSRCT.lnk'

# --- native helper: create a .lnk WITH an explicit AppUserModelID, and read
#     an AppUserModelID back off an existing .lnk (IShellLink + IPropertyStore).
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TSRCT {

[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW {
  void GetPath([Out] System.Text.StringBuilder f, int c, IntPtr fd, int flags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out] System.Text.StringBuilder n, int c);
  void SetDescription(string n);
  void GetWorkingDirectory([Out] System.Text.StringBuilder d, int c);
  void SetWorkingDirectory(string d);
  void GetArguments([Out] System.Text.StringBuilder a, int c);
  void SetArguments(string a);
  void GetHotkey(out short h); void SetHotkey(short h);
  void GetShowCmd(out int s); void SetShowCmd(int s);
  void GetIconLocation([Out] System.Text.StringBuilder i, int c, out int idx);
  void SetIconLocation(string i, int idx);
  void SetRelativePath(string r, int f);
  void Resolve(IntPtr hwnd, int f);
  void SetPath(string p);
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPersistFile {
  void GetClassID(out Guid c); int IsDirty();
  void Load(string f, int m); void Save(string f, [MarshalAs(UnmanagedType.Bool)] bool remember);
  void SaveCompleted(string f); void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
}

[StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  void GetCount(out uint c);
  void GetAt(uint i, out PropertyKey k);
  void GetValue(ref PropertyKey k, [Out] PropVariant v);
  void SetValue(ref PropertyKey k, PropVariant v);
  void Commit();
}

[StructLayout(LayoutKind.Explicit)] sealed class PropVariant : IDisposable {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr p;
  public PropVariant() {}
  public PropVariant(string s) { vt = 31 /*VT_LPWSTR*/; p = Marshal.StringToCoTaskMemUni(s); }
  public string AsString() { return vt == 31 ? Marshal.PtrToStringUni(p) : null; }
  public void Dispose() { if (p != IntPtr.Zero) { Marshal.FreeCoTaskMem(p); p = IntPtr.Zero; } }
}

public static class Api {
  // {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3},5  == PKEY_AppUserModel_ID
  static PropertyKey PKEY() {
    return new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
  }

  public static void Create(string lnk, string target, string args, string workdir,
                            string icon, string desc, string aumid) {
    var link = (IShellLinkW)new CShellLink();
    link.SetPath(target);
    if (!string.IsNullOrEmpty(args))    link.SetArguments(args);
    if (!string.IsNullOrEmpty(workdir)) link.SetWorkingDirectory(workdir);
    if (!string.IsNullOrEmpty(icon))    link.SetIconLocation(icon, 0);
    if (!string.IsNullOrEmpty(desc))    link.SetDescription(desc);
    link.SetShowCmd(1);
    if (!string.IsNullOrEmpty(aumid)) {
      var store = (IPropertyStore)link;
      var k = PKEY();
      using (var v = new PropVariant(aumid)) { store.SetValue(ref k, v); store.Commit(); }
    }
    ((IPersistFile)link).Save(lnk, true);
  }

  public static string ReadAumid(string lnk) {
    var link = (IShellLinkW)new CShellLink();
    ((IPersistFile)link).Load(lnk, 0);
    var store = (IPropertyStore)link;
    var k = PKEY();
    var v = new PropVariant();
    try { store.GetValue(ref k, v); return v.AsString(); }
    catch { return null; } finally { v.Dispose(); }
  }
}

} // namespace TSRCT
'@

function Write-Launcher([string]$aumid) {
    $iconArg = if (Test-Path $ico) { $ico } else { '' }
    [TSRCT.Api]::Create(
        $lnkPath,
        "$env:WINDIR\System32\wscript.exe",
        "`"$vbs`"",
        $root,
        $iconArg,
        'TSRCT - Tesseract Remote Control Terminal',
        $aumid)
}

# --- locate the installed PWA's AUMID (if the app was installed) -------------
# --- is the PWA present in the WORK profile's app registry? ------------------
$webApps = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\$profileDir\Web Applications"
$crxDir  = Join-Path $webApps "_crx_$expectedId"
$installed = (Test-Path $crxDir) -or (Test-Path (Join-Path $webApps "Manifest Resources\$expectedId"))

# --- read the PWA's AUMID from Chrome's own shortcut. Chrome drops a master
#     TSRCT.lnk inside the _crx_ folder (and copies to Desktop/Start Menu);
#     any of them carries System.AppUserModel.ID. Scan all likely spots.
$pwaAumid = $null
$lnkHunt = @(
    (Join-Path $crxDir '*.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Chrome Apps\*.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) '*.lnk')
)
foreach ($pat in $lnkHunt) {
    foreach ($c in (Get-ChildItem $pat -ErrorAction SilentlyContinue)) {
        if ($c.BaseName -eq 'TSRCT' -and $c.FullName -ne $lnkPath) {
            $a = [TSRCT.Api]::ReadAumid($c.FullName)
            if ($a) { $pwaAumid = $a; break }
        }
    }
    if ($pwaAumid) { break }
}

if ($installed) {
    Set-Content -Path $appIdFile -Value $expectedId -NoNewline -Encoding ascii
    Write-Launcher $pwaAumid
    Write-Host "[+] Shortcut created: $lnkPath"
    if ($pwaAumid) {
        Write-Host "[+] Grouped under PWA identity: $pwaAumid"
        Write-Host "[+] Launcher will open the installed PWA (crisp icon, one taskbar button)."
    } else {
        Write-Host "[!] PWA app files found but couldn't read its AUMID shortcut."
        Write-Host "    The app id is set, but the launcher may still show as a separate button."
    }
    Write-Host "[i] Re-pin: unpin the old TSRCT taskbar icon, then drag this new Desktop shortcut to the taskbar."
} else {
    # No PWA yet -> still (re)create the launcher with the crisp icon, but tell
    # the user to install the PWA once so we can group + upgrade the icon.
    Write-Launcher $null
    Write-Host "[+] Shortcut created (crisp icon): $lnkPath"
    Write-Host ""
    Write-Host "[i] ONE-TIME STEP to kill the 'second box' + low-res icon:"
    Write-Host "    1. Launch TSRCT (the app opens under your WORK Chrome profile)."
    Write-Host "    2. In that Chrome app window: menu (...) -> 'Install TSRCT...' (or the"
    Write-Host "       install icon in the address bar). Confirm."
    Write-Host "    3. Re-run this script:  powershell -ExecutionPolicy Bypass -File install-shortcut.ps1"
    Write-Host "       It will detect the PWA, group the taskbar button, and switch to the crisp icon."
    Write-Host ""
    Write-Host "    Expected app id: $expectedId"
}
