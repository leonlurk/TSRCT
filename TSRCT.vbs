' TSRCT launcher — runs the PowerShell orchestrator fully hidden (no console flash).
' Double-click this (or a shortcut to it) to boot the server + splash + open the app.
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\launch-tsrct.ps1""", 0, False
